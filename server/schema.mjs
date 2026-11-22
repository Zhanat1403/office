export const schema = `
CREATE SCHEMA IF NOT EXISTS balance_office;

CREATE TABLE IF NOT EXISTS balance_office.users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS balance_office.sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES balance_office.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiration ON balance_office.sessions(expires_at);

CREATE TABLE IF NOT EXISTS balance_office.projects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES balance_office.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id)
);

CREATE TABLE IF NOT EXISTS balance_office.documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES balance_office.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  media_type text NOT NULL,
  size integer NOT NULL CHECK (size >= 0),
  kind text NOT NULL CHECK (kind IN ('document', 'image')),
  body bytea NOT NULL,
  text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_by_user ON balance_office.documents(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS balance_office.threads (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES balance_office.users(id) ON DELETE CASCADE,
  project_id uuid,
  title text NOT NULL,
  agent_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, project_id) REFERENCES balance_office.projects(user_id, id)
);
CREATE INDEX IF NOT EXISTS threads_by_user ON balance_office.threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS balance_office.messages (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  request_id uuid,
  sequence bigserial NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'error')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, thread_id) REFERENCES balance_office.threads(user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS messages_by_thread ON balance_office.messages(user_id, thread_id, sequence);

CREATE TABLE IF NOT EXISTS balance_office.rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiration ON balance_office.rate_limits(expires_at);
`;
