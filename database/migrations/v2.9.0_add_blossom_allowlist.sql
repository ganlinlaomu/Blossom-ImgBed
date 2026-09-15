-- Blossom write access is independent from blob ownership and ImgBed storage metadata.
CREATE TABLE IF NOT EXISTS blossom_allowed_pubkeys (
    pubkey TEXT PRIMARY KEY,
    note TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blossom_allowed_pubkeys_created_at
    ON blossom_allowed_pubkeys(created_at DESC);
