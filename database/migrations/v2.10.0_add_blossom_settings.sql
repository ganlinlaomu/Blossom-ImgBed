-- Add the persisted Blossom write switch without changing existing ImgBed data.
INSERT OR IGNORE INTO settings (key, value, category, description)
VALUES ('blossom_enabled', 'false', 'blossom', 'Enable Blossom BUD-11 write operations');
