import { checkDatabaseInitialization } from '../../utils/databaseAdapter.js';

export async function onRequestGet({ env }) {
    const database = await checkDatabaseInitialization(env);
    const response = {
        database: {
            configured: database.configured,
            initialized: database.initialized,
            type: database.type,
        },
    };

    if (database.configured && !database.initialized) {
        response.database.missingTables = database.missingTables;
    }

    return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
