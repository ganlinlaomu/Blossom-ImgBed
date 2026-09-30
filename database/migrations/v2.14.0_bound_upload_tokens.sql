ALTER TABLE blossom_upload_tokens ADD COLUMN content_hash TEXT;
ALTER TABLE blossom_upload_tokens ADD COLUMN max_bytes INTEGER;
ALTER TABLE blossom_upload_tokens ADD COLUMN used_at INTEGER;
