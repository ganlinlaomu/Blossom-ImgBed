CREATE TABLE IF NOT EXISTS blossom_hainei_challenges (
    challenge TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE TABLE IF NOT EXISTS blossom_hainei_tokens (
    token_hash TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blossom_hainei_challenges_expires_at
ON blossom_hainei_challenges(expires_at);

CREATE INDEX IF NOT EXISTS idx_blossom_hainei_tokens_expires_at
ON blossom_hainei_tokens(expires_at);
