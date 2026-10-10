import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { query, tx } from './db.js';
import { encryptJson, decryptJson, sha256 } from './crypto.js';
import { HttpError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Disk is only a *cache* of what's in Postgres. Safe to delete at any time.
// Lives inside the project so ESM ("type": "module") and node_modules (pg, mysql2...) resolve.
export const CACHE_DIR = path.join(__dirname, '.cache', 'functions');

const MAX_VERSIONS = 20;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export const LIMITS = {
    minTimeout: 100,
    maxTimeout: Number(process.env.MAX_TIMEOUT_MS) || 60000,
    minMemory: 64,
    maxMemory: 1024
};

export function assertName(name, label = 'Function') {
    if (!NAME_RE.test(name || '')) {
        throw new HttpError(400, `${label} name must match ${NAME_RE} (letters, digits, _ and -; max 64)`);
    }
}

function validateCode(code) {
    if (!code || typeof code !== 'string') throw new HttpError(400, 'Function code is required');
    if (code.length > 2 * 1024 * 1024) throw new HttpError(400, 'Code too large (max 2MB)');
    if (!code.includes('export')) throw new HttpError(400, 'Code must export a handler');
}

function validateInt(value, min, max, label) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new HttpError(400, `${label} must be an integer between ${min} and ${max}`);
    }
    return value;
}

const RESERVED_ENV = new Set(['PATH', 'HOME', 'PWD']);
function validateEnv(env) {
    if (env === null || env === undefined) return null;
    if (typeof env !== 'object' || Array.isArray(env)) throw new HttpError(400, '"env" must be an object');
    let size = 0;
    for (const [k, v] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HttpError(400, `Invalid env var name: ${k}`);
        if (RESERVED_ENV.has(k) || /^(NODE_|LD_|AWS_LAMBDA_)/.test(k)) {
            throw new HttpError(400, `Env var name is reserved: ${k}`);
        }
        if (typeof v !== 'string') throw new HttpError(400, `Env var ${k} must be a string`);
        size += k.length + v.length;
    }
    if (size > 32 * 1024) throw new HttpError(400, 'Env vars too large (max 32KB total)');
    return env;
}

function validateConnectionsList(list) {
    if (list === null || list === undefined) return null;
    if (!Array.isArray(list) || !list.every((n) => typeof n === 'string' && NAME_RE.test(n))) {
        throw new HttpError(400, '"connections" must be an array of connection names (or null for all)');
    }
    return list;
}

const toApi = (r) => ({
    name: r.name,
    version: r.current_version,
    timeoutMs: r.timeout_ms,
    memoryMb: r.memory_mb,
    connections: r.connections, // null = all of the client's connections
    createdAt: r.created_at,
    updatedAt: r.updated_at
});

// ---------------------------------------------------------------- CRUD

export async function listFunctions(clientId) {
    const { rows } = await query('select * from functions where client_id = $1 order by name', [clientId]);
    return rows.map(toApi);
}

async function getRow(clientId, name) {
    const { rows } = await query('select * from functions where client_id = $1 and name = $2', [clientId, name]);
    if (!rows.length) throw new HttpError(404, `Function "${name}" not found`);
    return rows[0];
}

export async function getFunction(clientId, name) {
    const row = await getRow(clientId, name);
    const { rows: versions } = await query(
        'select version, code_sha256, created_at from function_versions where function_id = $1 order by version desc',
        [row.id]
    );
    const env = row.env_encrypted ? decryptJson(row.env_encrypted, row.id) : {};
    return {
        ...toApi(row),
        envKeys: Object.keys(env), // values are never returned
        versions: versions.map((v) => ({ version: v.version, sha256: v.code_sha256, createdAt: v.created_at }))
    };
}

export async function getFunctionCode(clientId, name) {
    const row = await getRow(clientId, name);
    const { rows } = await query('select code from function_versions where function_id = $1 and version = $2', [row.id, row.current_version]);
    return rows[0].code;
}

export async function createFunction(clientId, name, code, opts = {}) {
    assertName(name);
    validateCode(code);
    const timeoutMs = opts.timeoutMs === undefined ? 15000 : validateInt(opts.timeoutMs, LIMITS.minTimeout, LIMITS.maxTimeout, 'timeoutMs');
    const memoryMb = opts.memoryMb === undefined ? 128 : validateInt(opts.memoryMb, LIMITS.minMemory, LIMITS.maxMemory, 'memoryMb');
    const env = validateEnv(opts.env);
    const connections = validateConnectionsList(opts.connections);

    const id = crypto.randomUUID();
    try {
        await tx(async (q) => {
            await q(
                `insert into functions (id, client_id, name, current_version, timeout_ms, memory_mb, env_encrypted, connections)
                 values ($1, $2, $3, 1, $4, $5, $6, $7)`,
                [id, clientId, name, timeoutMs, memoryMb, env ? encryptJson(env, id) : null, connections]
            );
            await q('insert into function_versions (function_id, version, code, code_sha256) values ($1, 1, $2, $3)', [id, code, sha256(code)]);
        });
    } catch (err) {
        if (err.code === '23505') throw new HttpError(409, `Function "${name}" already exists`);
        throw err;
    }
    return { name, version: 1 };
}

/** Deploy new code as a new immutable version. */
export async function deployVersion(clientId, name, code) {
    validateCode(code);
    return tx(async (q) => {
        const { rows } = await q('select id from functions where client_id = $1 and name = $2 for update', [clientId, name]);
        if (!rows.length) throw new HttpError(404, `Function "${name}" not found`);
        const id = rows[0].id;

        const { rows: [{ next }] } = await q('select coalesce(max(version), 0) + 1 as next from function_versions where function_id = $1', [id]);
        await q('insert into function_versions (function_id, version, code, code_sha256) values ($1, $2, $3, $4)', [id, next, code, sha256(code)]);
        await q('update functions set current_version = $2, updated_at = now() where id = $1', [id, next]);
        await q('delete from function_versions where function_id = $1 and version <= $2', [id, next - MAX_VERSIONS]);
        return { name, version: next };
    });
}

export async function rollback(clientId, name, version) {
    const { rowCount } = await query(
        `update functions set current_version = $3, updated_at = now()
         where client_id = $1 and name = $2
           and exists (select 1 from function_versions v where v.function_id = functions.id and v.version = $3)`,
        [clientId, name, version]
    );
    if (!rowCount) throw new HttpError(404, 'Function or version not found');
    return { name, version };
}

export async function updateConfig(clientId, name, patch) {
    const row = await getRow(clientId, name);
    const sets = [];
    const params = [row.id];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (patch.timeoutMs !== undefined) add('timeout_ms', validateInt(patch.timeoutMs, LIMITS.minTimeout, LIMITS.maxTimeout, 'timeoutMs'));
    if (patch.memoryMb !== undefined) add('memory_mb', validateInt(patch.memoryMb, LIMITS.minMemory, LIMITS.maxMemory, 'memoryMb'));
    if (patch.connections !== undefined) add('connections', validateConnectionsList(patch.connections));
    if (patch.env !== undefined) {
        const env = validateEnv(patch.env); // replaces the whole set
        add('env_encrypted', env && Object.keys(env).length ? encryptJson(env, row.id) : null);
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to update (timeoutMs, memoryMb, env, connections)');

    await query(`update functions set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    return getFunction(clientId, name);
}

export async function deleteFunction(clientId, name) {
    const { rows } = await query('delete from functions where client_id = $1 and name = $2 returning id', [clientId, name]);
    if (!rows.length) throw new HttpError(404, `Function "${name}" not found`);
    await fs.rm(path.join(CACHE_DIR, rows[0].id), { recursive: true, force: true });
    return { deleted: name };
}

// ---------------------------------------------------------------- invocation support

/** Everything needed to run the function, without loading the code itself. */
export async function getInvokable(clientId, name) {
    const { rows } = await query(
        `select f.id, f.name, f.current_version, f.timeout_ms, f.memory_mb, f.env_encrypted, f.connections, v.code_sha256
         from functions f
         join function_versions v on v.function_id = f.id and v.version = f.current_version
         where f.client_id = $1 and f.name = $2`,
        [clientId, name]
    );
    if (!rows.length) throw new HttpError(404, `Function "${name}" not found`);
    return rows[0];
}

/**
 * Materialize code from Postgres to .cache/functions/<fnId>/<sha256>/index.js.
 * The directory is content-addressed => immutable, so no cache-busting is needed
 * and a new deploy automatically gets a fresh module path.
 */
export async function ensureEntry(fn) {
    const dir = path.join(CACHE_DIR, fn.id, fn.code_sha256);
    const entry = path.join(dir, 'index.js');
    try {
        await fs.access(entry);
        return { dir, entry };
    } catch { /* not cached yet */ }

    const { rows } = await query('select code from function_versions where function_id = $1 and version = $2', [fn.id, fn.current_version]);
    if (!rows.length) throw new HttpError(500, 'Function code is missing');

    await fs.mkdir(dir, { recursive: true });
    const tmp = `${entry}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, rows[0].code, 'utf8');
    await fs.rename(tmp, entry); // atomic
    return { dir, entry };
}

export async function recordInvocation(rec) {
    await query(
        `insert into invocations (id, client_id, function_id, function_name, version, status, duration_ms, error, logs)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rec.id, rec.clientId, rec.functionId, rec.functionName, rec.version, rec.status, rec.durationMs, rec.error, rec.logs]
    );
}

export async function listInvocations(clientId, name, limit = 20) {
    const row = await getRow(clientId, name);
    const { rows } = await query(
        `select id, version, status, duration_ms, error, logs, created_at
         from invocations where function_id = $1 order by created_at desc limit $2`,
        [row.id, Math.min(Math.max(Number(limit) || 20, 1), 100)]
    );
    return rows;
}
