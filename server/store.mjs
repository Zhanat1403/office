import { createHash, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { schema } from './schema.mjs'

const { Pool } = pg
const stores = new Map()
const sessionCookie = 'balance_session'
const sessionLifetime = 7 * 24 * 60 * 60
const maxDocumentBytes = 128 * 1024 * 1024
const maxDocuments = 200
const chatStaleInterval = "interval '3 minutes'"
const projectColumns = 'id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"'
const documentColumns = 'id, name, media_type AS "mediaType", size, created_at AS "createdAt"'
const threadColumns = `
  t.id, t.title, t.agent_id AS "agentId", t.project_id AS "projectId", t.status,
  t.updated_at AS "updatedAt", t.created_at AS "createdAt",
  (SELECT count(*)::integer FROM balance_office.messages AS m
    WHERE m.user_id = t.user_id AND m.thread_id = t.id) AS "messageCount"
`

export class DataError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function shortLabel(text, documents) {
  const source = text.trim().replace(/\s+/g, ' ') || documents[0]?.name || 'Новый диалог'
  return source.length > 100 ? source.slice(0, 97).trimEnd() + '…' : source
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex')
}

function tokenFromRequest(request) {
  const cookie = request.headers.get('cookie') ?? ''
  const prefix = sessionCookie + '='
  const token = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))
  const secret = token?.slice(prefix.length)
  return secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null
}

export function sessionHeader(request, token = '') {
  const maxAge = token ? sessionLifetime : 0
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export const isId = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)

class Store {
  constructor(connectionString) {
    this.connectionString = connectionString
  }

  async database() {
    if (!this.connectionString) throw new DataError(503, 'База данных ещё не настроена.')
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.connectionString,
        max: 4,
        idleTimeoutMillis: 15_000,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        application_name: 'balance-office',
        allowExitOnIdle: true,
      })
      this.pool.on('error', error => console.error('PostgreSQL idle connection:', error.code))
    }
    if (!this.initializing) {
      this.initializing = this.migrate().catch(error => {
        this.initializing = null
        throw error
      })
    }
    await this.initializing
    return this.pool
  }

  async migrate() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(674120612)')
      await client.query(schema)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async query(sql, parameters) {
    return (await this.database()).query(sql, parameters)
  }

  async transaction(callback) {
    const pool = await this.database()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async register({ email, name, passwordHash }) {
    const { rows } = await this.query(`
      INSERT INTO balance_office.users(id, name, email, password_hash)
      VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING
      RETURNING id, name, email, settings
    `, [randomUUID(), name, email, passwordHash])
    if (!rows.length) throw new DataError(409, 'Аккаунт с таким адресом уже существует.')
    return rows[0]
  }

  async credentials(email) {
    const { rows } = await this.query(`
      SELECT id, name, email, settings, password_hash AS "passwordHash"
      FROM balance_office.users WHERE email = $1
    `, [email])
    return rows[0] ?? null
  }

  async createSession(userId, request) {
    const token = randomBytes(32).toString('base64url')
    const old = tokenFromRequest(request)
    await this.transaction(async client => {
      await client.query(`
        DELETE FROM balance_office.sessions
        WHERE expires_at <= now() OR token_hash = $1
      `, [old ? tokenDigest(old) : null])
      await client.query(`
        INSERT INTO balance_office.sessions (token_hash, user_id, expires_at)
        VALUES ($1, $2, now() + $3 * interval '1 second')
      `, [tokenDigest(token), userId, sessionLifetime])
    })
    return token
  }

  async sessionUser(request) {
    const token = tokenFromRequest(request)
    if (!token) return null
    const { rows } = await this.query(`
      SELECT u.id, u.name, u.email, u.settings
      FROM balance_office.sessions AS s JOIN balance_office.users AS u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
    `, [tokenDigest(token)])
    return rows[0] ?? null
  }

  async closeSession(request) {
    const token = tokenFromRequest(request)
    if (token) await this.query('DELETE FROM balance_office.sessions WHERE token_hash = $1', [tokenDigest(token)])
  }

  async rateLimit(key, limit, windowSeconds, client = this) {
    if (client === this && (this.nextBucketCleanup ?? 0) < Date.now()) {
      this.nextBucketCleanup = Date.now() + 15 * 60 * 1000
      await this.query('DELETE FROM balance_office.rate_limits WHERE expires_at <= now()')
    }
    const { rows } = await client.query(`
      INSERT INTO balance_office.rate_limits AS bucket(key, count, expires_at)
      VALUES ($1, 1, now() + $2 * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN bucket.expires_at <= now() THEN 1 ELSE bucket.count + 1 END,
        expires_at = CASE WHEN bucket.expires_at <= now() THEN EXCLUDED.expires_at ELSE bucket.expires_at END
      WHERE bucket.expires_at <= now() OR bucket.count < $3
      RETURNING count, expires_at
    `, [key, windowSeconds, limit])
    if (!rows.length) throw new DataError(429, 'Слишком много запросов. Попробуйте позже.')
  }

  async settings(userId, name, settings) {
    const { rows } = await this.query(`
      UPDATE balance_office.users SET name = COALESCE($2, name), settings = settings || $3::jsonb
      WHERE id = $1 RETURNING id, name, email, settings
    `, [userId, name ?? null, JSON.stringify(settings)])
    return rows[0]
  }

  async state(userId) {
    await this.expireChats(userId)
    const [projects, documents, threads] = await Promise.all([
      this.query(`
        SELECT ${projectColumns} FROM balance_office.projects
        WHERE user_id = $1 ORDER BY updated_at DESC, id
      `, [userId]),
      this.query(`
        SELECT ${documentColumns} FROM balance_office.documents
        WHERE user_id = $1 ORDER BY created_at DESC, id
      `, [userId]),
      this.query(`
        SELECT ${threadColumns} FROM balance_office.threads AS t
        WHERE t.user_id = $1 ORDER BY t.updated_at DESC, t.id
      `, [userId]),
    ])
    return { projects: projects.rows, documents: documents.rows, threads: threads.rows }
  }

  async createProject(userId, { name, description }) {
    const { rows } = await this.query(`
      INSERT INTO balance_office.projects(id, user_id, name, description) VALUES ($1, $2, $3, $4)
      RETURNING ${projectColumns}
    `, [randomUUID(), userId, name, description ?? ''])
    return rows[0]
  }

  async updateProject(userId, id, { name, description }) {
    const { rows } = await this.query(`
      UPDATE balance_office.projects
      SET name = COALESCE($3, name), description = COALESCE($4, description), updated_at = now()
      WHERE user_id = $1 AND id = $2 RETURNING ${projectColumns}
    `, [userId, id, name ?? null, description ?? null])
    if (!rows.length) throw new DataError(404, 'Проект не найден.')
    return rows[0]
  }

  async deleteProject(userId, id) {
    await this.transaction(async client => {
      await client.query('SELECT id FROM balance_office.users WHERE id = $1 FOR UPDATE', [userId])
      const project = await client.query(`
        SELECT id FROM balance_office.projects WHERE user_id = $1 AND id = $2 FOR UPDATE
      `, [userId, id])
      if (!project.rowCount) throw new DataError(404, 'Проект не найден.')
      await client.query('UPDATE balance_office.threads SET project_id = NULL WHERE user_id = $1 AND project_id = $2', [userId, id])
      await client.query('DELETE FROM balance_office.projects WHERE user_id = $1 AND id = $2', [userId, id])
    })
  }

  async addDocument(userId, { name, mediaType, size, kind, body, text }) {
    return this.transaction(async client => {
      await client.query('SELECT id FROM balance_office.users WHERE id = $1 FOR UPDATE', [userId])
      const { rows: [usage] } = await client.query(`
        SELECT count(*)::integer AS count, COALESCE(sum(size), 0)::integer AS bytes
        FROM balance_office.documents WHERE user_id = $1
      `, [userId])
      if (usage.count >= maxDocuments || usage.bytes + size > maxDocumentBytes) {
        throw new DataError(413, 'В базе знаний закончилось место. Удалите ненужные файлы.')
      }
      const { rows } = await client.query(`
        INSERT INTO balance_office.documents (id, user_id, name, media_type, size, kind, body, text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING ${documentColumns}
      `, [randomUUID(), userId, name, mediaType, size, kind, body, text ?? ''])
      return rows[0]
    })
  }

  async document(userId, id) {
    const { rows } = await this.query(`
      SELECT ${documentColumns}, kind, body FROM balance_office.documents WHERE user_id = $1 AND id = $2
    `, [userId, id])
    if (!rows.length) throw new DataError(404, 'Файл не найден.')
    return rows[0]
  }

  async deleteDocument(userId, id) {
    const result = await this.query('DELETE FROM balance_office.documents WHERE user_id = $1 AND id = $2', [userId, id])
    if (!result.rowCount) throw new DataError(404, 'Файл не найден.')
  }

  async chatDocuments(userId, ids, { allowMissing = false } = {}) {
    if (!ids.length) return []
    const { rows } = await this.query(`
      SELECT ${documentColumns}, kind,
        CASE WHEN kind = 'image' OR (media_type = 'application/pdf' AND text = '') THEN body ELSE NULL END AS body,
        text
      FROM balance_office.documents WHERE user_id = $1 AND id = ANY($2::uuid[])
      ORDER BY array_position($2::uuid[], id)
    `, [userId, ids])
    if (!allowMissing && rows.length !== ids.length) throw new DataError(404, 'Один из прикреплённых файлов не найден.')
    return rows
  }

  async expireChats(userId, client = this) {
    await client.query(`
      WITH expired AS (
        UPDATE balance_office.threads SET status = 'error', updated_at = now()
        WHERE user_id = $1 AND status = 'running' AND updated_at < now() - ${chatStaleInterval}
        RETURNING id
      )
      UPDATE balance_office.messages SET status = 'error',
        content = CASE WHEN content = '' THEN 'Анализ прервался. Отправьте запрос ещё раз.' ELSE content END
      WHERE user_id = $1 AND status = 'running' AND thread_id IN (SELECT id FROM expired)
    `, [userId])
  }

  async thread(userId, id) {
    await this.expireChats(userId)
    const { rows } = await this.query(`
      SELECT ${threadColumns} FROM balance_office.threads AS t WHERE t.user_id = $1 AND t.id = $2
    `, [userId, id])
    if (!rows.length) throw new DataError(404, 'Диалог не найден.')
    const { rows: messages } = await this.query(`
      SELECT id, role, content, documents, status, steps, created_at AS "createdAt"
      FROM balance_office.messages WHERE user_id = $1 AND thread_id = $2 ORDER BY sequence
    `, [userId, id])
    return { thread: rows[0], messages }
  }

  async deleteThread(userId, id) {
    await this.transaction(async client => {
      await this.expireChats(userId, client)
      const { rows: [thread] } = await client.query(`
        SELECT status FROM balance_office.threads WHERE user_id = $1 AND id = $2 FOR UPDATE
      `, [userId, id])
      if (!thread) throw new DataError(404, 'Диалог не найден.')
      if (thread.status === 'running') throw new DataError(409, 'Дождитесь окончания анализа перед удалением диалога.')
      await client.query('DELETE FROM balance_office.threads WHERE user_id = $1 AND id = $2', [userId, id])
    })
  }

  async moveThread(userId, id, projectId) {
    return this.transaction(async client => {
      await client.query('SELECT id FROM balance_office.users WHERE id = $1 FOR UPDATE', [userId])
      if (projectId) {
        const project = await client.query(`
          SELECT id FROM balance_office.projects WHERE user_id = $1 AND id = $2 FOR KEY SHARE
        `, [userId, projectId])
        if (!project.rowCount) throw new DataError(404, 'Проект не найден.')
      }
      const result = await client.query(`
        UPDATE balance_office.threads SET project_id = $3, updated_at = now()
        WHERE user_id = $1 AND id = $2
      `, [userId, id, projectId])
      if (!result.rowCount) throw new DataError(404, 'Диалог не найден.')
      const { rows } = await client.query(`
        SELECT ${threadColumns} FROM balance_office.threads AS t WHERE t.user_id = $1 AND t.id = $2
      `, [userId, id])
      return rows[0]
    })
  }

  async beginChat(userId, { agentId, threadId, projectId, text, documentIds, requestId }) {
    return this.transaction(async client => {
      await client.query('SELECT id FROM balance_office.users WHERE id = $1 FOR UPDATE', [userId])
      const duplicate = await client.query(`
        SELECT 1 FROM balance_office.messages WHERE user_id = $1 AND request_id = $2
      `, [userId, requestId])
      if (duplicate.rowCount) throw new DataError(409, 'Запрос уже сохранён. Откройте его в истории.')
      await this.expireChats(userId, client)

      // Project deletion and chat attachment take the same lock before modifying a thread.
      if (projectId) {
        const project = await client.query(`
          SELECT id FROM balance_office.projects WHERE user_id = $1 AND id = $2 FOR KEY SHARE
        `, [userId, projectId])
        if (!project.rowCount) throw new DataError(404, 'Проект не найден.')
      }

      if (threadId) {
        const { rows: [thread] } = await client.query(`
          SELECT id, status FROM balance_office.threads WHERE user_id = $1 AND id = $2 FOR UPDATE
        `, [userId, threadId])
        if (!thread) throw new DataError(404, 'Диалог не найден.')
        if (thread.status === 'running') throw new DataError(409, 'Анализ в этом диалоге уже выполняется.')
      }
      const active = await client.query(`
        SELECT 1 FROM balance_office.threads WHERE user_id = $1 AND status = 'running' LIMIT 2
      `, [userId])
      if (active.rowCount >= 2) throw new DataError(429, 'Сначала дождитесь завершения текущих анализов.')
      await this.rateLimit('chat:' + userId, 30, 3600, client)

      const { rows: documents } = await client.query(`
        SELECT id, name FROM balance_office.documents WHERE user_id = $1 AND id = ANY($2::uuid[])
        ORDER BY array_position($2::uuid[], id)
      `, [userId, documentIds])
      if (documents.length !== documentIds.length) throw new DataError(404, 'Один из прикреплённых файлов не найден.')

      const id = threadId ?? randomUUID()
      const { rows: history } = threadId ? await client.query(`
        SELECT role, content, documents FROM (
          SELECT sequence, role, content, documents
          FROM balance_office.messages
          WHERE user_id = $1 AND thread_id = $2 AND status = 'completed'
          ORDER BY sequence DESC LIMIT 20
        ) AS latest ORDER BY sequence
      `, [userId, id]) : { rows: [] }

      if (threadId) {
        await client.query(`
          UPDATE balance_office.threads SET status = 'running', agent_id = $3,
            project_id = COALESCE($4, project_id), updated_at = now()
          WHERE user_id = $1 AND id = $2
        `, [userId, id, agentId, projectId ?? null])
      } else {
        await client.query(`
          INSERT INTO balance_office.threads (id, user_id, project_id, title, agent_id, status)
          VALUES ($1, $2, $3, $4, $5, 'running')
        `, [id, userId, projectId ?? null, shortLabel(text, documents), agentId])
      }

      const messageId = randomUUID()
      const userMessageId = randomUUID()
      await client.query(`
        INSERT INTO balance_office.messages (id, user_id, thread_id, request_id, role, content, documents, status)
        VALUES ($1, $2, $3, $4, 'user', $5, $6, 'completed'),
               ($7, $2, $3, NULL, 'assistant', '', '[]', 'running')
      `, [userMessageId, userId, id, requestId, text, JSON.stringify(documents), messageId])
      return { threadId: id, messageId, userMessageId, history, documents }
    })
  }

  async updateChatProgress(userId, { threadId, messageId, steps }) {
    await this.query(`
      UPDATE balance_office.messages SET steps = $4::jsonb
      WHERE user_id = $1 AND thread_id = $2 AND id = $3 AND status = 'running'
    `, [userId, threadId, messageId, JSON.stringify(steps)])
  }

  async finishChat(userId, { threadId, messageId, status, text, steps }) {
    const finalStatus = status === 'completed' ? 'completed' : 'error'
    await this.transaction(async client => {
      await client.query('SELECT id FROM balance_office.threads WHERE user_id = $1 AND id = $2 FOR UPDATE', [userId, threadId])
      const message = await client.query(`
        UPDATE balance_office.messages SET status = $4, content = $5, steps = $6::jsonb
        WHERE user_id = $1 AND thread_id = $2 AND id = $3 AND role = 'assistant' AND status = 'running'
      `, [userId, threadId, messageId, finalStatus, text, JSON.stringify(steps ?? [])])
      if (message.rowCount) {
        await client.query(`
          UPDATE balance_office.threads SET status = $3, updated_at = now() WHERE user_id = $1 AND id = $2
        `, [userId, threadId, finalStatus])
      }
    })
  }
}

export function getStore(env) {
  const connectionString = (env.DATABASE_URL || '').trim()
  if (!stores.has(connectionString)) stores.set(connectionString, new Store(connectionString))
  return stores.get(connectionString)
}
