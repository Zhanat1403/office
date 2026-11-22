import { account, chooseModel } from './account.mjs'
import { parseDocument } from './document-parser.mjs'
import { generate } from './gemini.mjs'
import { getStore } from './store.mjs'

const agents = new Set([
  'personal', 'finance', 'tutor', 'wellbeing', 'nutrition', 'fitness', 'medical', 'stylist', 'interior',
  'travel', 'legal', 'career', 'parenting', 'shopping', 'content', 'home', 'coordinator',
  'analytic', 'strategist', 'researcher', 'auditor',
])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const maxChatBytes = 64 * 1024
const maxChatDocuments = 4
const encoder = new TextEncoder()

function errorResponse(status, error) {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
}

function expectedError(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
}

function publicError(error) {
  if (expectedError(error)) return error.message
  console.error('Office request failed', error?.code ?? error?.name ?? 'unknown')
  return 'Произошла серверная ошибка. Попробуйте ещё раз.'
}

async function readChatRequest(request) {
  if (!request.body || Number(request.headers.get('content-length')) > maxChatBytes) return null
  let count = 0
  let body = ''
  const reader = request.body.pipeThrough(new TextDecoderStream()).getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      count += encoder.encode(value).byteLength
      if (count > maxChatBytes) {
        await reader.cancel()
        return null
      }
      body += value
    }
    return JSON.parse(body)
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

function chatInput(payload) {
  if (!payload || typeof payload !== 'object' || !agents.has(payload.agentId)) return null
  const { agentId, threadId, projectId, requestId, documentIds = [] } = payload
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (text.length > 16_000 || text.includes('\0') || (!text && !documentIds?.length)) return null
  if (typeof requestId !== 'string' || !uuid.test(requestId)) return null
  if ([threadId, projectId].some(id => id != null && (typeof id !== 'string' || !uuid.test(id)))) return null
  if (!Array.isArray(documentIds) || documentIds.length > maxChatDocuments ||
    documentIds.some(id => typeof id !== 'string' || !uuid.test(id))) return null
  return { agentId, threadId, projectId, requestId, documentIds: [...new Set(documentIds)], text }
}

function streamChat({ request, env, store, user, input, documents, run, deadline }) {
  const { threadId, messageId, history } = run
  const cancelled = new AbortController()
  const signal = AbortSignal.any([request.signal, cancelled.signal, deadline])
  let stopped = false
  let work

  const body = new ReadableStream({
    start(controller) {
      const send = event => {
        if (!stopped) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      send({ type: 'start', threadId, messageId })

      work = (async () => {
        const stages = new Map()
        let progress = Promise.resolve()
        let partial = ''
        let final = ''
        let message

        try {
          const previousIds = [...new Set(history.slice().reverse().flatMap(turn => turn.documents?.map(file => file.id) ?? []))]
            .filter(id => !input.documentIds.includes(id)).slice(0, maxChatDocuments - documents.length)
          const previousDocuments = await store.chatDocuments(user.id, previousIds, { allowMissing: true })
          final = await generate({
            env,
            model: chooseModel(env, user.settings?.model),
            agentId: input.agentId,
            text: input.text,
            history,
            documents: [...documents, ...previousDocuments],
            signal,
            onStage(stage) {
              stages.set(stage.agentId, stage)
              send({ type: 'stage', ...stage })
              if (store.updateChatProgress) {
                const steps = [...stages.values()]
                progress = progress.then(() => store.updateChatProgress(user.id, { threadId, messageId, steps }))
                  .catch(error => console.error('Could not save workflow progress', error?.code ?? error?.name))
              }
            },
            onDelta(text) {
              partial += text
              send({ type: 'delta', text })
            },
          })
          if (typeof final !== 'string' || !final.trim()) {
            message = 'Gemini вернул пустой ответ. Попробуйте ещё раз.'
          }
        } catch (error) {
          message = deadline.aborted ? 'Gemini не успел ответить. Сократите запрос или повторите попытку.' :
            signal.aborted ? 'Запрос был прерван.' : publicError(error)
        }

        const steps = [...stages.values()].map(stage =>
          message && stage.status === 'running' ? { ...stage, status: 'failed', text: message } : stage)
        await progress
        try {
          await store.finishChat(user.id, {
            threadId,
            messageId,
            status: message ? 'error' : 'completed',
            text: message ? partial : final,
            steps,
          })
        } catch (error) {
          console.error('Could not save chat result', error?.code ?? error?.name)
          message = 'Не удалось сохранить ответ. Попробуйте ещё раз.'
        }

        if (message) send({ type: 'error', error: message, threadId, messageId })
        else send({ type: 'done', threadId, messageId, text: final, status: 'completed' })
      })().finally(() => {
        if (!stopped) controller.close()
      })
    },
    async cancel() {
      stopped = true
      cancelled.abort()
      await work
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

async function handleChat(request, env, store) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Используйте POST.' }, { status: 405, headers: { allow: 'POST' } })
  }
  const user = await store.sessionUser(request)
  if (!user) return errorResponse(401, 'Войдите в аккаунт, чтобы начать диалог.')
  if (!env.GEMINI_API_KEY?.trim()) return errorResponse(503, 'Gemini пока не настроен на сервере.')
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return errorResponse(415, 'Ожидается запрос в формате JSON.')
  }

  const deadline = AbortSignal.timeout(110_000)
  const input = chatInput(await readChatRequest(request))
  if (!input) return errorResponse(400, 'Выберите специалиста и введите задачу или прикрепите документы.')
  const documents = await store.chatDocuments(user.id, input.documentIds)
  const run = await store.beginChat(user.id, input)
  return streamChat({ request, env, store, user, input, documents, run, deadline })
}

export async function handleApi(request, env, meta = {}) {
  const url = new URL(request.url)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin')
    if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      return errorResponse(403, 'Запрос должен быть отправлен с этого сайта.')
    }
  }

  try {
    const store = getStore(env)
    if (url.pathname === '/api/chat') return await handleChat(request, env, store)
    return await account(request, env, store, parseDocument, meta) ??
      errorResponse(404, 'Маршрут не найден.')
  } catch (error) {
    return errorResponse(expectedError(error) ? error.status : 500, publicError(error))
  }
}
