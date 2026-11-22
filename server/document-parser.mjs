import { win32 } from "node:path";
import { SaxesParser } from "saxes";
import { getDocumentProxy } from "unpdf";
import yauzl from "yauzl";

export const maxDocumentBytes = 3 * 1024 * 1024;
const maxExtractedCharacters = 800_000;
const maxDocumentXmlBytes = 8 * 1024 * 1024;
const maxPdfPages = 120;
const wordNamespaces = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const mediaTypes = new Map([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

function documentError(status, message) {
  return Object.assign(new Error(message), { status });
}

function ensureTextLimit(length) {
  if (length > maxExtractedCharacters) {
    throw documentError(413, "В документе слишком много текста. Разделите его на несколько файлов.");
  }
}

function decodeText(body) {
  if (body[0] === 0xff && body[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(body);
  }
  if (body[0] === 0xfe && body[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: true }).decode(body);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

async function readPdf(body) {
  if (body.subarray(0, 1024).indexOf("%PDF-") === -1) throw new Error("Invalid PDF header.");
  const pdf = await getDocumentProxy(Uint8Array.from(body), {
    stopAtErrors: true,
    isEvalSupported: false,
    disableFontFace: true,
    enableXfa: false,
  });

  try {
    if (pdf.numPages > maxPdfPages) {
      throw documentError(413, `В PDF больше ${maxPdfPages} страниц. Разделите его на несколько файлов.`);
    }

    const pages = [];
    let extractedLength = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      try {
        const { items } = await page.getTextContent();
        const text = items.map((item) => typeof item.str === "string"
          ? item.str + (item.hasEOL ? "\n" : " ")
          : "").join("").trim();
        if (text) {
          extractedLength += text.length;
          ensureTextLimit(extractedLength);
          pages.push(`Страница ${number}\n${text}`);
        }
      } finally {
        page.cleanup();
      }
    }
    return pages.join("\n\n");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function openZip(body) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(body, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

async function readWordXml(body) {
  const zip = await openZip(body);
  try {
    if (zip.entryCount > 2048) throw documentError(413, "В DOCX слишком много вложенных файлов.");
    const entry = await new Promise((resolve, reject) => {
      zip.once("error", reject);
      zip.once("end", () => reject(new Error("Missing word/document.xml.")));
      zip.on("entry", (item) => {
        if (item.fileName === "word/document.xml") resolve(item);
        else zip.readEntry();
      });
      zip.readEntry();
    });
    if (entry.uncompressedSize > maxDocumentXmlBytes) {
      throw documentError(413, "Текстовая часть DOCX слишком велика. Разделите документ на несколько файлов.");
    }

    const stream = await new Promise((resolve, reject) => {
      zip.openReadStream(entry, (error, source) => {
        if (error) reject(error);
        else resolve(source);
      });
    });
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > maxDocumentXmlBytes) throw documentError(413, "Текстовая часть DOCX слишком велика.");
      chunks.push(chunk);
    }
    return decodeText(Buffer.concat(chunks, length));
  } finally {
    zip.close();
  }
}

async function readDocx(body) {
  const xml = await readWordXml(body);
  const parser = new SaxesParser({ xmlns: true });
  const chunks = [];
  let length = 0;
  let textDepth = 0;
  function append(value) {
    length += value.length;
    ensureTextLimit(length);
    chunks.push(value);
  }
  parser.on("doctype", () => { throw new Error("Unexpected XML document type."); });
  parser.on("opentag", (tag) => {
    if (!wordNamespaces.has(tag.uri)) return;
    if (tag.local === "t") textDepth += 1;
    if (tag.local === "tab") append("\t");
    if (tag.local === "br" || tag.local === "cr") append("\n");
  });
  parser.on("text", (value) => {
    if (textDepth) append(value);
  });
  parser.on("closetag", (tag) => {
    if (!wordNamespaces.has(tag.uri)) return;
    if (tag.local === "t") textDepth -= 1;
    if (tag.local === "p" || tag.local === "tr") append("\n");
    if (tag.local === "tc") append("\t");
  });
  parser.write(xml).close();
  return chunks.join("");
}

function validateImage(body, mediaType) {
  const valid = {
    "image/png": () => body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/jpeg": () => body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
    "image/webp": () => body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP",
  }[mediaType];
  if (!valid()) throw documentError(422, "Изображение повреждено или его формат не соответствует расширению.");
}

export async function parseDocument(file) {
  if (!file || typeof file.name !== "string" || typeof file.arrayBuffer !== "function" || !file.size) {
    throw documentError(400, "Выберите непустой файл.");
  }
  if (file.size > maxDocumentBytes) {
    throw documentError(413, "Максимальный размер файла — 3 МБ.");
  }
  const name = win32.basename(file.name).normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (name.length > 180) throw documentError(400, "Имя файла слишком длинное.");
  const mediaType = mediaTypes.get(win32.extname(name).toLowerCase());
  if (!mediaType) throw documentError(415, "Поддерживаются PDF, DOCX, TXT, CSV, JPEG, PNG и WebP.");

  const body = Buffer.from(await file.arrayBuffer());
  const image = mediaType.startsWith("image/");
  let value = "";
  try {
    if (image) validateImage(body, mediaType);
    else if (mediaType === "application/pdf") value = await readPdf(body);
    else if (mediaType.endsWith("wordprocessingml.document")) value = await readDocx(body);
    else value = decodeText(body);
  } catch (error) {
    if (error.status) throw error;
    const message = mediaType.startsWith("text/")
      ? "Не удалось прочитать файл. Сохраните текст или таблицу в кодировке UTF-8."
      : "Не удалось прочитать файл. Проверьте формат, целостность и отсутствие пароля.";
    throw documentError(422, message);
  }

  const text = value.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  ensureTextLimit(text.length);
  if (!image && mediaType !== "application/pdf" && !text) {
    throw documentError(422, "В файле нет текста для анализа.");
  }
  return { name, mediaType, size: body.length, kind: image ? "image" : "document", body, text };
}
