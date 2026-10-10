import { query, tx } from './db.js';
import { generateApiKey } from './crypto.js';
import { HttpError } from './errors.js';

export async function createClient({ name, email }) {
    if (!name || typeof name !== 'string' || name.length > 100) {
        throw new HttpError(400, '"name" is required (max 100 chars)');
    }
    try {
        return await tx(async (q) => {
            const { rows: [client] } = await q(
                'insert into clients (name, email) values ($1, $2) returning id, name, email, status, created_at',
                [name, email || null]
            );
            const key = generateApiKey();
            await q(
                'insert into api_keys (client_id, label, key_prefix, key_hash) values ($1, $2, $3, $4)',
                [client.id, 'default', key.prefix, key.hash]
            );
            return { ...client, apiKey: key.plain }; // shown once
        });
    } catch (err) {
        if (err.code === '23505') throw new HttpError(409, 'A client with this email already exists');
        throw err;
    }
}

export async function listClients() {
    const { rows } = await query(`
        select c.id, c.name, c.email, c.status, c.created_at,
               (select count(*) from functions f where f.client_id = c.id)::int as functions
        from clients c order by c.created_at`);
    return rows;
}

export async function setClientStatus(id, status) {
    if (!['active', 'suspended'].includes(status)) {
        throw new HttpError(400, 'status must be "active" or "suspended"');
    }
    const { rows } = await query('update clients set status = $2 where id = $1 returning id, name, status', [id, status]);
    if (!rows.length) throw new HttpError(404, 'Client not found');
    return rows[0];
}

export async function issueApiKey(clientId, label) {
    const { rows } = await query('select 1 from clients where id = $1', [clientId]);
    if (!rows.length) throw new HttpError(404, 'Client not found');
    const key = generateApiKey();
    const { rows: [row] } = await query(
        'insert into api_keys (client_id, label, key_prefix, key_hash) values ($1, $2, $3, $4) returning id, label, created_at',
        [clientId, label || null, key.prefix, key.hash]
    );
    return { ...row, apiKey: key.plain }; // shown once
}

export async function listApiKeys(clientId) {
    const { rows } = await query(
        'select id, label, key_prefix, created_at, last_used_at, revoked_at from api_keys where client_id = $1 order by created_at',
        [clientId]
    );
    return rows;
}

export async function revokeApiKey(clientId, keyId) {
    const { rowCount } = await query(
        'update api_keys set revoked_at = now() where id = $1 and client_id = $2 and revoked_at is null',
        [keyId, clientId]
    );
    if (!rowCount) throw new HttpError(404, 'Active key not found');
    return { revoked: keyId };
}
