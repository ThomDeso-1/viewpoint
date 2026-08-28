-- Real sessions, replacing "the password itself is the cookie".
--
-- Only the SHA-256 of each token is stored: a leaked database file then
-- yields no usable session cookies. Tokens are random secrets, not
-- user-chosen, so a fast hash is appropriate here (unlike passwords).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Append-only access trail. Required once patient data is in play:
-- PHIPA expects a record of who touched personal health information and
-- of anything sent to a patient.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail      TEXT,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
