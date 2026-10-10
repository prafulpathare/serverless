import { query } from './db.js';
import { encryptJson, decryptJson } from './crypto.js';
import { HttpError } from './errors.js';
import { assertName } from './registry.js';

const PROTOCOLS = {
    postgres: ['postgres://', 'postgresql://'],
    mysql: ['mysql://'],
    mongodb: ['mongodb://', 'mongodb+srv://']
};

function hostOf(url) {
    try { return new URL(url).hostname || null; } catch { return null; }
}

export async function listConnections(clientId) {
    const { rows } = await query('select name, type, config_encrypted, created_at, updated_at from connections where client_id = $1 order by name', [clientId]);
    return rows.map((r) => {
        const cfg = decryptJson(r.config_encrypted, clientId);
        // never return the URL (it contains credentials)
        return { name: r.name, type: r.type, host: hostOf(cfg.url), ssl: !!cfg.ssl, createdAt: r.created_at, updatedAt: r.updated_at };
    });
}

export async function upsertConnection(clientId, name, body) {
    assertName(name, 'Connection');
    const { type, url, ssl, rejectUnauthorized } = body || {};
    if (!PROTOCOLS[type]) throw new HttpError(400, `"type" must be one of: ${Object.keys(PROTOCOLS).join(', ')}`);
    if (typeof url !== 'string' || !PROTOCOLS[type].some((p) => url.startsWith(p))) {
        throw new HttpError(400, `"url" must start with ${PROTOCOLS[type].join(' or ')}`);
    }
    const config = { url, ssl: !!ssl, rejectUnauthorized: rejectUnauthorized !== false };

    await query(
        `insert into connections (client_id, name, type, config_encrypted)
         values ($1, $2, $3, $4)
         on conflict (client_id, name)
         do update set type = excluded.type, config_encrypted = excluded.config_encrypted, updated_at = now()`,
        [clientId, name, type, encryptJson(config, clientId)]
    );
    return { name, type, host: hostOf(url), ssl: config.ssl };
}

export async function deleteConnection(clientId, name) {
    const { rowCount } = await query('delete from connections where client_id = $1 and name = $2', [clientId, name]);
    if (!rowCount) throw new HttpError(404, `Connection "${name}" not found`);
    return { deleted: name };
}

/** Decrypted connection configs a function may use. allowlist === null => all of the client's. */
export async function resolveConnections(clientId, allowlist) {
    const { rows } = await query(
        `select name, type, config_encrypted from connections
         where client_id = $1 and ($2::text[] is null or name = any($2))`,
        [clientId, allowlist]
    );
    return rows.map((r) => ({ name: r.name, type: r.type, ...decryptJson(r.config_encrypted, clientId) }));
}
