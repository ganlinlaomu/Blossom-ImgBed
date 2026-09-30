CREATE TABLE IF NOT EXISTS blossom_blob_operations (
    sha256 TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    operation TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blossom_token_issue_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blossom_token_issue_limits_expires_at
ON blossom_token_issue_limits(expires_at);

CREATE TABLE IF NOT EXISTS blossom_upload_slots (
    owner TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);
