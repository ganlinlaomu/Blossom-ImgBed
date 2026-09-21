-- Replace client-tag authorization with service-issued, short-lived upload tokens.
-- The deprecated blossom_hainei_* tables are intentionally retained for upgrade safety.
CREATE TABLE IF NOT EXISTS blossom_upload_tokens (
    token_hash TEXT PRIMARY KEY,
    subject_pubkey TEXT NOT NULL,
    scope TEXT NOT NULL,
    issued_by TEXT,
    parent_token_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_blossom_upload_tokens_expires_at
ON blossom_upload_tokens(expires_at);

CREATE INDEX IF NOT EXISTS idx_blossom_upload_tokens_subject_pubkey
ON blossom_upload_tokens(subject_pubkey);

CREATE TABLE IF NOT EXISTS hainei_users (
    pubkey TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS hainei_auth_challenges (
    challenge_hash TEXT PRIMARY KEY,
    pubkey TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_hainei_auth_challenges_expires_at
ON hainei_auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS hainei_media_usage (
    pubkey TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    upload_count INTEGER NOT NULL DEFAULT 0,
    upload_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(pubkey, usage_date)
);

DELETE FROM settings
WHERE key IN (
    'blossom_allow_hainei_clients_without_allowlist',
    'blossom_require_allowlist_for_non_hainei_clients'
);
