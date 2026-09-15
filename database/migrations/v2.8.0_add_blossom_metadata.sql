CREATE TABLE IF NOT EXISTS blossom_blobs (
    sha256 TEXT PRIMARY KEY,
    imgbed_id TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blossom_ownership (
    sha256 TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (sha256, pubkey),
    FOREIGN KEY (sha256) REFERENCES blossom_blobs(sha256) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blossom_ownership_pubkey ON blossom_ownership(pubkey);
