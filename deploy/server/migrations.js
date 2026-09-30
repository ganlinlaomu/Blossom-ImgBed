import { createHash } from 'node:crypto';

// Runs against the native SQLite handle, so schema changes and the ledger commit together.
export function applyMigrations(database, migrations) {
    database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
    )`);
    for (const { name, sql } of [...migrations].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
        const checksum = createHash('sha256').update(sql).digest('hex');
        database.exec('BEGIN IMMEDIATE');
        try {
            const existing = database.prepare('SELECT checksum FROM schema_migrations WHERE name = ?').get(name);
            if (existing) {
                if (existing.checksum !== checksum) throw new Error(`Migration changed after application: ${name}`);
            } else {
                // Older installations have no ledger. Skip only columns verified to exist;
                // continue executing the remaining statements (e.g. indexes and other columns).
                const compatibleSql = sql.replace(
                    /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z_0-9]*)\s+ADD\s+(?:COLUMN\s+)?([A-Za-z_][A-Za-z_0-9]*)\s+[^;]+;/gi,
                    (statement, table, column) => {
                        const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
                        return columns.some(item => item.name.toLowerCase() === column.toLowerCase()) ? '' : statement;
                    },
                );
                database.exec(compatibleSql);
                database.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(name, checksum, Date.now());
            }
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            throw new Error(`Database migration failed: ${name}`, { cause: error });
        }
    }
}
