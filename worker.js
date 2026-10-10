import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Client database access: context.getConnection('<name>')
//   postgres -> pg.Pool        (await db.query('select ...', [params]))
//   mysql    -> mysql2 pool    (const [rows] = await db.query('select ...'))
//   mongodb  -> MongoClient    (db.db('mydb').collection('x').find())
// Connections are opened lazily and closed automatically after the handler returns.
// ---------------------------------------------------------------------------
async function openConnection(cfg) {
    const ssl = cfg.ssl ? { rejectUnauthorized: cfg.rejectUnauthorized !== false } : undefined;

    switch (cfg.type) {
        case 'postgres': {
            const { default: pg } = await import('pg');
            const pool = new pg.Pool({ connectionString: cfg.url, ssl, max: 2, connectionTimeoutMillis: 5000 });
            pool.on('error', () => {});
            return { client: pool, close: () => pool.end() };
        }
        case 'mysql': {
            const mod = await import('mysql2/promise');
            const pool = (mod.default || mod).createPool({ uri: cfg.url, ssl, connectionLimit: 2, connectTimeout: 5000 });
            return { client: pool, close: () => pool.end() };
        }
        case 'mongodb': {
            const { MongoClient } = await import('mongodb');
            const client = new MongoClient(cfg.url, {
                maxPoolSize: 2,
                serverSelectionTimeoutMS: 5000,
                ...(cfg.ssl && { tls: true })
            });
            await client.connect();
            return { client, close: () => client.close() };
        }
        default:
            throw new Error(`Unsupported connection type: ${cfg.type}`);
    }
}

function send(payload, exitCode = 0) {
    try {
        process.send(payload, () => process.exit(exitCode));
    } catch {
        process.send({ error: 'Function result is not serializable' }, () => process.exit(exitCode));
    }
}

process.on('unhandledRejection', (err) => send({ error: `Unhandled rejection: ${err?.message || err}` }, 1));
process.on('uncaughtException', (err) => send({ error: `Uncaught exception: ${err?.message || err}` }, 1));

process.on('message', async (job) => {
    const open = new Map(); // name -> Promise<{client, close}>
    const deadline = Date.now() + job.context.timeoutMs;

    const context = {
        ...job.context,
        getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
        connections: job.connections.map((c) => ({ name: c.name, type: c.type })),
        getConnection: async (name) => {
            const cfg = job.connections.find((c) => c.name === name);
            if (!cfg) {
                const names = job.connections.map((c) => c.name).join(', ') || 'none';
                throw new Error(`Connection "${name}" is not available to this function (available: ${names})`);
            }
            if (!open.has(name)) {
                const p = openConnection(cfg);
                open.set(name, p);
                p.catch(() => open.delete(name));
            }
            return (await open.get(name)).client;
        }
    };

    let payload;
    try {
        const mod = await import(pathToFileURL(job.entry).href);
        const handler = mod.handler || mod.default;
        if (typeof handler !== 'function') {
            throw new Error('No valid handler exported. Make sure you export `handler`');
        }
        const result = await handler(job.event, context);
        payload = { result: result === undefined ? null : result };
    } catch (err) {
        payload = { error: err?.message || String(err) };
    }

    // close client DB connections gracefully (max 2s)
    const closers = [...open.values()].map((p) => p.then((c) => c.close()).catch(() => {}));
    await Promise.race([Promise.allSettled(closers), new Promise((r) => setTimeout(r, 2000))]);

    send(payload);
});
