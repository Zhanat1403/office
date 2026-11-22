import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { DataError, isId, sessionHeader } from './store.mjs'

const hashPassword = promisify(scrypt)
const passwordOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const defaultModel = 'gemini-3.1-flash-lite'
const modelIdPattern = /^gemini-[a-z0-9.-]{1,70}$/
const uploadLimit = 3 * 1024 * 1024
const multipartLimit = uploadLimit + 64 * 1024

const digest = value => createHash('sha256').update(value).digest()

export function modelOptions(env) {
  const configured = (env.GEMINI_MODELS ?? '').split(',').map(model => model.trim())
  const primary = env.GEMINI_MODEL?.trim()
  const selected = modelIdPattern.test(primary ?? '') ? primary : defaultModel
  const ids = [...new Set([selected, ...configured.filter(model => modelIdPattern.test(model))])]
  return ids.map(id => ({
    id,
    label: id.startsWith('gemini-')
      ? 'Gemini ' + id.slice(7).replace(/flash-lite/g, 'Flash-Lite').replace(/\bflash\b/g, 'Flash').replace(/\bpro\b/g, 'Pro').replace(/-/g, ' ').replace('Flash Lite', 'Flash-Lite')
      : id,
  }))
}

export function chooseModel(env, model) {
  const options = modelOptions(env)
  return options.some(option => option.id === model) ? model : options[0].id
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'private, no-store', ...headers } })
}

const publicUser = user => user ? { id: user.id, name: user.name, email: user.email } : null

function publicSettings(env, settings = {}) {
  return {
    model: chooseModel(env, settings.model),
    compact: settings.compact === true,
    notifications: settings.notifications !== false,
  }
}

async function readBytes(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) {
    throw new DataError(413, 'Запрос слишком большой.')
  }
  if (!request.body) throw new DataError(400, 'Запрос пуст.')
  const chunks = []
  const reader = request.body.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        throw new DataError(413, 'Запрос слишком большой.')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    reader.releaseLock()
  }
}

async function readJson(request) {
  const mime = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (mime !== 'application/json') throw new DataError(415, 'Ожидается запрос JSON.')
  const bytes = await readBytes(request, 32 * 1024)
  try {
    const data = JSON.parse(bytes.toString('utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) return data
  } catch {
    // Return the same validation error as for non-object JSON.
  }
  throw new DataError(400, 'Неверный формат запроса.')
}

function inspectedText(value, maxLength, message, required = true) {
  if (typeof value !== 'string') throw new DataError(400, message)
  const result = value.trim()
  if ((required && !result) || result.length > maxLength || result.includes('\0')) {
    throw new DataError(400, message)
  }
  return result
}

function emailAddress(value) {
  const message = 'Введите действительный адрес электронной почты.'
  const email = inspectedText(value, 254, message).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DataError(400, message)
  return email
}

async function passwordRecord(password) {
  const salt = randomBytes(16)
  const key = await hashPassword(password, salt, 64, passwordOptions)
  return salt.toString('hex') + ':' + key.toString('hex')
}

async function validPassword(password, record) {
  const [saltHex, keyHex] = record?.split(':') ?? []
  const key = keyHex ? Buffer.from(keyHex, 'hex') : Buffer.alloc(64)
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : Buffer.alloc(16)
  const actual = await hashPassword(password, salt, 64, passwordOptions)
  return key.length === actual.length && timingSafeEqual(actual, key) && Boolean(record)
}

async function authenticate(request, env, store, ip) {
  const { action, email: rawEmail, password, name, registrationCode } = await readJson(request)
  if (action === 'logout') {
    await store.closeSession(request)
    return json({ user: null }, 200, { 'set-cookie': sessionHeader(request) })
  }
  if (action !== 'signup' && action !== 'login') {
    throw new DataError(400, 'Выберите вход или регистрацию.')
  }
  const email = emailAddress(rawEmail)
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new DataError(400, 'Пароль должен содержать от 8 до 200 символов.')
  }

  const networkKey = digest(ip || 'unknown').toString('hex')
  const emailKey = digest(email).toString('hex')
  await store.rateLimit(`auth:${action}:ip:${networkKey}`, action === 'signup' ? 18 : 36, 900)
  await store.rateLimit(`auth:${action}:email:${emailKey}`, 8, 900)

  let user
  if (action === 'signup') {
    const expectedCode = env.REGISTRATION_CODE?.trim()
    if (expectedCode && (typeof registrationCode !== 'string' || !timingSafeEqual(digest(registrationCode.trim()), digest(expectedCode)))) {
      throw new DataError(403, 'Введите действительный код регистрации.')
    }
    const userName = inspectedText(name, 100, 'Введите имя длиной не более 100 символов.')
    user = await store.register({ email, name: userName, passwordHash: await passwordRecord(password) })
  } else {
    user = await store.credentials(email)
    if (!await validPassword(password, user?.passwordHash)) {
      throw new DataError(401, 'Неверный адрес электронной почты или пароль.')
    }
  }
  const token = await store.createSession(user.id, request)
  return json({ user: publicUser(user) }, action === 'signup' ? 201 : 200, {
    'set-cookie': sessionHeader(request, token),
  })
}

function projectInput(data, required) {
  const name = (required || data.name !== undefined)
    ? inspectedText(data.name, 120, 'Введите название проекта длиной не более 120 символов.')
    : undefined
  const description = data.description === undefined
    ? undefined
    : inspectedText(data.description, 2000, 'Описание должно быть не длиннее 2000 символов.', false)
  return { name, description }
}

async function upload(request, userId, store, parseDocument) {
  const mime = request.headers.get('content-type')
  if (!mime || !/^multipart\/form-data\s*;/i.test(mime)) {
    throw new DataError(415, 'Отправьте файл как часть формы.')
  }
  await store.rateLimit('upload:' + userId, 30, 3600)
  const bytes = await readBytes(request, multipartLimit)
  let form
  try {
    form = await new Request(request.url, { method: 'POST', headers: { 'content-type': mime }, body: bytes }).formData()
  } catch {
    throw new DataError(400, 'Не удалось прочитать файл.')
  }
  const files = form.getAll('file')
  if (files.length !== 1 || typeof files[0] === 'string' || !files[0].size) {
    throw new DataError(400, 'Выберите один непустой файл.')
  }
  if (files[0].size > uploadLimit) throw new DataError(413, 'Размер файла превышает 3 МБ.')
  const parsed = await parseDocument(files[0])
  return json({ document: await store.addDocument(userId, parsed) }, 201)
}

function fileDisposition(name) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase())
  return "attachment; filename*=UTF-8''" + encoded
}

function methodNotAllowed(allow) {
  return json({ error: 'Этот метод не поддерживается.' }, 405, { allow })
}

export async function account(request, env, store, parseDocument, { ip } = {}) {
  const path = new URL(request.url).pathname.replace(/\/$/, '')
  const method = request.method
  const match = /^\/api\/(projects|documents|threads)\/([^/]+)$/.exec(path)
  if (!match && !['/api/state', '/api/auth', '/api/settings', '/api/projects', '/api/documents'].includes(path)) {
    return null
  }

  if (path === '/api/auth') {
    return method === 'POST' ? authenticate(request, env, store, ip) : methodNotAllowed('POST')
  }

  const user = await store.sessionUser(request)
  if (path === '/api/state') {
    if (method !== 'GET') return methodNotAllowed('GET')
    const data = user
      ? await store.state(user.id)
      : { projects: [], documents: [], threads: [] }
    return json({
      ...data,
      user: publicUser(user),
      settings: publicSettings(env, user?.settings),
      models: modelOptions(env),
      aiConfigured: Boolean(env.GEMINI_API_KEY?.trim()),
      registrationCodeRequired: Boolean(env.REGISTRATION_CODE?.trim()),
    })
  }
  if (!user) throw new DataError(401, 'Войдите в аккаунт, чтобы продолжить.')

  if (path === '/api/settings') {
    if (method !== 'PATCH') return methodNotAllowed('PATCH')
    const data = await readJson(request)
    const settings = {}
    if (data.model !== undefined) {
      if (!modelOptions(env).some(option => option.id === data.model)) {
        throw new DataError(400, 'Выберите доступную модель Gemini.')
      }
      settings.model = data.model
    }
    for (const key of ['compact', 'notifications']) {
      if (data[key] !== undefined) {
        if (typeof data[key] !== 'boolean') throw new DataError(400, 'Неверный формат настройки.')
        settings[key] = data[key]
      }
    }
    const name = data.name === undefined
      ? undefined
      : inspectedText(data.name, 100, 'Введите имя длиной не более 100 символов.')
    const updated = await store.settings(user.id, name, settings)
    return json({ user: publicUser(updated), settings: publicSettings(env, updated.settings) })
  }
  if (path === '/api/projects') {
    if (method !== 'POST') return methodNotAllowed('POST')
    const body = projectInput(await readJson(request), true)
    return json({ project: await store.createProject(user.id, body) }, 201)
  }
  if (path === '/api/documents') {
    return method === 'POST' ? upload(request, user.id, store, parseDocument) : methodNotAllowed('POST')
  }

  const [, resource, id] = match
  if (!isId(id)) throw new DataError(404, 'Запись не найдена.')
  if (resource === 'projects') {
    if (method === 'PATCH') {
      const data = projectInput(await readJson(request), false)
      return json({ project: await store.updateProject(user.id, id, data) })
    }
    if (method !== 'DELETE') return methodNotAllowed('PATCH, DELETE')
    await store.deleteProject(user.id, id)
    return new Response(null, { status: 204 })
  }
  if (resource === 'documents') {
    if (method === 'GET') {
      const document = await store.document(user.id, id)
      return new Response(document.body, {
        headers: {
          'cache-control': 'private, no-store',
          'content-disposition': fileDisposition(document.name),
          'content-type': document.mediaType,
          'x-content-type-options': 'nosniff',
        },
      })
    }
    if (method !== 'DELETE') return methodNotAllowed('GET, DELETE')
    await store.deleteDocument(user.id, id)
    return new Response(null, { status: 204 })
  }
  if (method === 'GET') return json(await store.thread(user.id, id))
  if (method === 'PATCH') {
    const { projectId } = await readJson(request)
    if (projectId !== null && !isId(projectId)) throw new DataError(400, 'Выберите существующий проект.')
    return json({ thread: await store.moveThread(user.id, id, projectId) })
  }
  if (method !== 'DELETE') return methodNotAllowed('GET, PATCH, DELETE')
  await store.deleteThread(user.id, id)
  return new Response(null, { status: 204 })
}
