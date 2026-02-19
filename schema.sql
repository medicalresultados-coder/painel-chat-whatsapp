CREATE TABLE IF NOT EXISTS conversations (
  wa_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  wa_id TEXT NOT NULL REFERENCES conversations(wa_id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  text TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_wa_id_at ON messages(wa_id, at DESC);
