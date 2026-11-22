function build(tag, content) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

function inline(parent, text, depth = 0) {
  if (depth > 5) {
    parent.append(text);
    return;
  }

  const tokens = /\x60([^\x60]+)\x60|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~/gi;
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(text.slice(cursor, match.index));
    const [, code, link, url, strong, strongAlt, emphasis, emphasisAlt, strike] = match;
    if (code) {
      parent.append(build('code', code));
    } else if (link) {
      const anchor = build('a', link);
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      parent.append(anchor);
    } else {
      const node = build(strong || strongAlt ? 'strong' : strike ? 'del' : 'em');
      inline(node, strong || strongAlt || emphasis || emphasisAlt || strike, depth + 1);
      parent.append(node);
    }
    cursor = match.index + match[0].length;
  }
  parent.append(text.slice(cursor));
}

function cells(line) {
  const value = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return value.split(/(?<!\\)\|/).map(cell => cell.replaceAll('\\|', '|').trim());
}

function tableAt(lines, index) {
  return lines[index]?.includes('|') && lines[index + 1]?.includes('-')
    && cells(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell));
}

const fence = /^\s*(?:\x60{3,}|~{3,})(.*)$/;
const heading = /^(#{1,6})\s+(.+)$/;
const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/;
const rule = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function markdown(text, depth = 0) {
  const out = document.createDocumentFragment();
  if (depth > 8) {
    out.append(build('p', text));
    return out;
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    if (fence.test(line)) {
      const marker = line.trim().at(0);
      const code = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker.repeat(3))) {
        code.push(lines[index++]);
      }
      if (index < lines.length) index++;
      const pre = build('pre');
      pre.append(build('code', code.join('\n')));
      out.append(pre);
      continue;
    }

    if (tableAt(lines, index)) {
      const wrap = build('div');
      wrap.className = 'office-table';
      const table = build('table');
      const head = table.createTHead().insertRow();
      const headings = cells(line);
      for (const value of headings) {
        const cell = build('th');
        cell.scope = 'col';
        inline(cell, value);
        head.append(cell);
      }
      const body = table.createTBody();
      index += 2;
      while (lines[index]?.includes('|')) {
        const row = body.insertRow();
        const values = cells(lines[index++]);
        headings.forEach((_, col) => inline(row.insertCell(), values[col] || ''));
      }
      wrap.append(table);
      out.append(wrap);
      continue;
    }

    const title = line.match(heading);
    if (title) {
      const node = build(`h${Math.min(title[1].length + 2, 6)}`);
      inline(node, title[2].replace(/\s+#+\s*$/, ''));
      out.append(node);
      index++;
      continue;
    }

    if (rule.test(line)) {
      out.append(build('hr'));
      index++;
      continue;
    }

    const item = line.match(list);
    if (item) {
      const ordered = /^\d/.test(item[1]);
      const group = build(ordered ? 'ol' : 'ul');
      if (ordered) group.start = parseInt(item[1], 10);
      while (index < lines.length) {
        const entry = lines[index].match(list);
        if (!entry || /^\d/.test(entry[1]) !== ordered) break;
        const node = build('li');
        inline(node, entry[2]);
        group.append(node);
        index++;
      }
      out.append(group);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = build('blockquote');
      const content = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        content.push(lines[index++].replace(/^\s*>\s?/, ''));
      }
      quote.append(markdown(content.join('\n'), depth + 1));
      out.append(quote);
      continue;
    }

    const paragraph = build('p');
    inline(paragraph, line);
    index++;
    while (lines[index]?.trim() && !heading.test(lines[index]) && !rule.test(lines[index])
      && !list.test(lines[index]) && !fence.test(lines[index]) && !/^\s*>/.test(lines[index])
      && !tableAt(lines, index)) {
      paragraph.append(build('br'));
      inline(paragraph, lines[index++]);
    }
    out.append(paragraph);
  }
  return out;
}
