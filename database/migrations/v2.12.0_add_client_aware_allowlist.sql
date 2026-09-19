ALTER TABLE blossom_hainei_tokens ADD COLUMN client_info TEXT;

INSERT OR IGNORE INTO settings (key, value, category, description)
VALUES
    ('blossom_allow_hainei_clients_without_allowlist', 'true', 'blossom', 'Allow HaiNei clients to upload without pubkey allowlist checks'),
    ('blossom_require_allowlist_for_non_hainei_clients', 'true', 'blossom', 'Require non-HaiNei short-lived token clients to pass pubkey allowlist checks');

CREATE INDEX IF NOT EXISTS idx_blossom_hainei_tokens_client_info
ON blossom_hainei_tokens(client_info);
