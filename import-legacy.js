// One-off: import users.json + functions/<userId>/<fn>/index.js into Postgres.
// Existing API keys keep working (they are hashed, not changed).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, query } from '../db.js';
import { sha256 } from '../crypto.js';
import { createFunction } from '../registry.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const usersFile = path.join(root, 'users.json');
const functionsDir = path.join(root, 'functions');

try {
    const { clients } = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

    for (const [legacyId, data] of Object.entries(clients)) {
        const hash = sha256(data.apiKey);
        let { rows } = await query('select client_id from api_keys where key_hash = $1', [hash]);
        let clientId = rows[0]?.client_id;

        if (!clientId) {
            ({ rows } = await query('insert into clients (name) values ($1) returning id', [data.name]));
            clientId = rows[0].id;
            await query(
                'insert into api_keys (client_id, label, key_prefix, key_hash) values ($1, $2, $3, $4)',
                [clientId, `imported:${legacyId}`, data.apiKey.slice(0, 12), hash]
            );
            console.log(`+ client ${data.name} (${legacyId} -> ${clientId})`);
        }

        const userDir = path.join(functionsDir, legacyId);
        if (!fs.existsSync(userDir)) continue;
        for (const name of fs.readdirSync(userDir)) {
            const indexPath = path.join(userDir, name, 'index.js');
            if (!fs.existsSync(indexPath)) continue;
            try {
                await createFunction(clientId, name, fs.readFileSync(indexPath, 'utf8'));
                console.log(`  + function ${name}`);
            } catch (err) {
                console.log(`  - skipped ${name}: ${err.message}`);
            }
        }
    }
} finally {
    await pool.end();
}
