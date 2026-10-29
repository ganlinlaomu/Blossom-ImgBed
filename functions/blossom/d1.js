// Statements in one D1 batch share a single round trip and run as one
// transaction. Without batch support (test doubles) they run in order.
export async function d1Batch(db, statements) {
    if (typeof db.batch === 'function') return db.batch(statements);
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
}

export function changed(result) {
    return Number(result?.meta?.changes || 0) === 1;
}
