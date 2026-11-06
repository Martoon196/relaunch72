-- Growth HQ Webinars — initial schema (D1 / SQLite).
-- Every tenant-owned row is reachable from brand_id, and the top-level tenant tables
-- (webinars, registrants, events, webhook_endpoints) also carry `mode` so test keys can
-- never read or write live data.
-- Times are ISO-8601 UTC strings (e.g. 2026-11-06T19:00:00.000Z) unless suffixed _s (seconds).

CREATE TABLE brands (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  theme_json     TEXT NOT NULL DEFAULT '{}',
  settings_json  TEXT NOT NULL DEFAULT '{}',
  ghq_account_id TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE api_keys (
  id              TEXT PRIMARY KEY,
  brand_id        TEXT REFERENCES brands(id) ON DELETE CASCADE, -- NULL = account-level secret key
  type            TEXT NOT NULL CHECK (type IN ('pk','sk')),
  mode            TEXT NOT NULL CHECK (mode IN ('live','test')),
  prefix          TEXT NOT NULL,           -- first 12 chars, safe to show in lists
  hash            TEXT NOT NULL UNIQUE,    -- SHA-256 hex of the full key
  display         TEXT,                    -- full value for publishable keys only (needed for embed snippets)
  name            TEXT,
  scopes          TEXT NOT NULL DEFAULT '["*"]',
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  last_used_at    TEXT,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_api_keys_brand ON api_keys(brand_id);

CREATE TABLE webinars (
  id                   TEXT PRIMARY KEY,
  brand_id             TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  mode                 TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live','test')),
  type                 TEXT NOT NULL CHECK (type IN ('live','on_demand','evergreen')),
  slug                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  presenters_json      TEXT NOT NULL DEFAULT '[]',
  agenda_json          TEXT NOT NULL DEFAULT '[]',
  handouts_json        TEXT NOT NULL DEFAULT '[]',
  stream_live_input_id TEXT,
  video_uid            TEXT,
  duration_s           INTEGER,
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  overrides_json       TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (brand_id, mode, slug)
);
CREATE INDEX idx_webinars_live_input ON webinars(stream_live_input_id);

CREATE TABLE slot_rules (
  id         TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('fixed','interval','just_in_time')),
  rule_json  TEXT NOT NULL DEFAULT '{}',
  timezone   TEXT NOT NULL DEFAULT 'Europe/London',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_slot_rules_webinar ON slot_rules(webinar_id);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  webinar_id    TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  starts_at     TEXT,
  ends_at       TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('live','evergreen','on_demand')),
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended')),
  test_mode     INTEGER NOT NULL DEFAULT 0, -- host is previewing privately; room not open to attendees
  recording_uid TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  finalized_at  TEXT,                       -- no-shows + leaves emitted
  created_at    TEXT NOT NULL,
  UNIQUE (webinar_id, kind, starts_at)
);
CREATE INDEX idx_sessions_webinar ON sessions(webinar_id, starts_at);
CREATE INDEX idx_sessions_status ON sessions(status, ends_at);

CREATE TABLE ctas (
  id         TEXT PRIMARY KEY,
  webinar_id TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  url        TEXT NOT NULL,
  style      TEXT NOT NULL DEFAULT 'button' CHECK (style IN ('button','card')),
  body       TEXT,
  image_url  TEXT,
  show_at_s  INTEGER,
  hide_at_s  INTEGER,
  push_mode  TEXT NOT NULL DEFAULT 'timed' CHECK (push_mode IN ('timed','manual')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ctas_webinar ON ctas(webinar_id);

CREATE TABLE registrants (
  id                TEXT PRIMARY KEY,
  brand_id          TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL DEFAULT 'live',
  webinar_id        TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  session_id        TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  email             TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  phone             TEXT,
  answers_json      TEXT NOT NULL DEFAULT '{}',
  consent_json      TEXT NOT NULL DEFAULT '{}',
  utm_json          TEXT NOT NULL DEFAULT '{}',
  source_url        TEXT,
  token_hash        TEXT NOT NULL UNIQUE,
  access_expires_at TEXT,
  banned            INTEGER NOT NULL DEFAULT 0,
  ghq_contact_id    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (webinar_id, email)
);
CREATE INDEX idx_registrants_brand_email ON registrants(brand_id, email);
CREATE INDEX idx_registrants_session ON registrants(session_id);

CREATE TABLE attendance (
  id             TEXT PRIMARY KEY,
  registrant_id  TEXT NOT NULL REFERENCES registrants(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  joined_at      TEXT NOT NULL,
  left_at        TEXT,
  last_seen_at   TEXT NOT NULL,
  watch_s        INTEGER NOT NULL DEFAULT 0,
  max_position_s INTEGER NOT NULL DEFAULT 0,
  position_s     INTEGER NOT NULL DEFAULT 0,
  device         TEXT,
  country        TEXT,
  left_emitted   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (registrant_id, session_id)
);
CREATE INDEX idx_attendance_session ON attendance(session_id);
CREATE INDEX idx_attendance_open ON attendance(left_emitted, last_seen_at);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  registrant_id TEXT REFERENCES registrants(id) ON DELETE CASCADE,
  host_id       TEXT,
  author_name   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('chat','question','answer')),
  parent_id     TEXT,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','pinned','pending')),
  done_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_messages_registrant ON messages(registrant_id);

CREATE TABLE polls (
  id           TEXT PRIMARY KEY,
  webinar_id   TEXT NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  show_at_s    INTEGER,
  crm_field    TEXT,          -- Growth HQ custom field the answer is written to
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_polls_webinar ON polls(webinar_id);

CREATE TABLE poll_votes (
  poll_id       TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  registrant_id TEXT NOT NULL REFERENCES registrants(id) ON DELETE CASCADE,
  session_id    TEXT,
  option        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (poll_id, registrant_id)
);

CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  brand_id      TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'live',
  type          TEXT NOT NULL,
  registrant_id TEXT,
  session_id    TEXT,
  webinar_id    TEXT,
  data_json     TEXT NOT NULL DEFAULT '{}',
  ts            TEXT NOT NULL
);
CREATE INDEX idx_events_brand_type ON events(brand_id, mode, type, ts);
CREATE INDEX idx_events_registrant ON events(registrant_id);
CREATE INDEX idx_events_webinar ON events(webinar_id, type);

CREATE TABLE webhook_endpoints (
  id         TEXT PRIMARY KEY,
  brand_id   TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL DEFAULT 'live',
  url        TEXT NOT NULL,
  -- HMAC needs the secret itself, so it is stored AES-GCM encrypted with DATA_KEY (plus a hash for audit).
  secret_enc TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  events     TEXT NOT NULL DEFAULT '["*"]',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_webhook_endpoints_brand ON webhook_endpoints(brand_id, mode);

CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  endpoint_id  TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  next_attempt_at TEXT,
  delivered_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_deliveries_status ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_deliveries_event ON webhook_deliveries(event_id);

CREATE TABLE audit_log (
  id       TEXT PRIMARY KEY,
  actor    TEXT NOT NULL,
  brand_id TEXT,
  action   TEXT NOT NULL,
  target   TEXT,
  ts       TEXT NOT NULL
);
CREATE INDEX idx_audit_brand ON audit_log(brand_id, ts);
