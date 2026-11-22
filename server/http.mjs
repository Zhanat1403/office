import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { handleApi } from './app.mjs'
import { getStore } from './store.mjs'

const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_ID)
const production = process.env.NODE_ENV === 'production' || onRailway
const host = process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1')
const port = Number(process.env.PORT || 4173)
const localOrigin = `http://127.0.0.1:${port}`
const staticRoot = fileURLToPath(new URL('../dist', import.meta.url))
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
}
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

async function serveFile(pathname) {
  const path = resolve(staticRoot, pathname === '/' ? './index.html' : `.${pathname}`)
  const contentType = types[extname(path)]
  if (!path.startsWith(staticRoot + sep) || !contentType) {
    return new Response('Not found', { status: 404 })
  }

  try {
    const body = await readFile(path)
    return new Response(body, {
      headers: { 'content-type': contentType, 'content-length': String(body.length) },
    })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return new Response('Not found', { status: 404 })
    }
    throw error
  }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const secure = onRailway && incoming.headers['x-forwarded-proto'] === 'https'
    const authority = secure ? incoming.headers['x-forwarded-host'] || incoming.headers.host : incoming.headers.host
    const origin = authority ? new URL(`${secure ? 'https' : 'http'}://${authority}`).origin : localOrigin
    const url = new URL(incoming.url, origin)
    if (url.origin !== origin || !incoming.url.startsWith('/') || incoming.url.startsWith('//')) {
      outgoing.writeHead(400, securityHeaders).end()
      return
    }
    const path = decodeURIComponent(url.pathname)
    const method = incoming.method
    let response

    if (path === '/health' && (method === 'GET' || method === 'HEAD')) {
      try {
        await getStore(process.env).query('SELECT 1')
        response = Response.json({ status: 'ok' })
      } catch {
        response = Response.json({ status: 'unavailable' }, { status: 503 })
      }
    } else if (path.startsWith('/api/')) {
      const controller = new AbortController()
      outgoing.on('close', () => {
        if (!outgoing.writableFinished) controller.abort()
      })
      const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(incoming)
      const railwayIP = onRailway && incoming.headers['x-real-ip']
      const ip = railwayIP && isIP(railwayIP) ? railwayIP : incoming.socket.remoteAddress
      response = await handleApi(new Request(url, {
        method,
        body,
        headers: incoming.headers,
        duplex: 'half',
        signal: controller.signal,
      }), process.env, { ip })
    } else if (method === 'GET' || method === 'HEAD') {
      response = await serveFile(path)
    } else {
      response = new Response('Method not allowed', { status: 405 })
    }

    outgoing.writeHead(response.status, { ...securityHeaders, ...Object.fromEntries(response.headers) })
    if (method === 'HEAD' || !response.body) {
      outgoing.end()
    } else {
      await pipeline(Readable.fromWeb(response.body), outgoing)
    }
  } catch (error) {
    if (outgoing.destroyed) return
    if (!outgoing.headersSent) {
      outgoing.writeHead(error instanceof URIError ? 400 : 500)
    }
    outgoing.end()
  }
})

server.listen(port, host, () => console.log(`Офис баланса запущен на http://${host}:${port}`))
