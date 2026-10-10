import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, requireAdmin } from './auth.js';
import { decryptJson } from './crypto.js';
import { HttpError } from './errors.js';
import {
    createClient, listClients, setClientStatus,
    issueApiKey, listApiKeys, revokeApiKey
} from './clients.js';
import {
    listFunctions, getFunction, getFunctionCode, createFunction, deployVersion,
    rollback, updateConfig, deleteFunction, getInvokable, ensureEntry,
    recordInvocation, listInvocations
} from './registry.js';
import { listConnections, upsertConnection, deleteConnection, resolveConnections } from './connections.js';
import { executeFunction } from './executor.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));

// Express 4 doesn't catch async errors by itself
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ========== Public ==========
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Local FaaS' }));

// ========== Admin (platform operator): x-admin-key ==========
app.post('/admin/clients', requireAdmin, wrap(async (req, res) => {
    res.status(201).json(await createClient(req.body || {})); // includes apiKey, shown once
}));
app.get('/admin/clients', requireAdmin, wrap(async (req, res) => res.json({ clients: await listClients() })));
app.patch('/admin/clients/:id', requireAdmin, wrap(async (req, res) => {
    res.json(await setClientStatus(req.params.id, req.body?.status));
}));
app.get('/admin/clients/:id/keys', requireAdmin, wrap(async (req, res) => res.json({ keys: await listApiKeys(req.params.id) })));
app.post('/admin/clients/:id/keys', requireAdmin, wrap(async (req, res) => {
    res.status(201).json(await issueApiKey(req.params.id, req.body?.label));
}));
app.delete('/admin/clients/:id/keys/:keyId', requireAdmin, wrap(async (req, res) => {
    res.json(await revokeApiKey(req.params.id, req.params.keyId));
}));

// ========== Client routes: x-api-key ==========
app.use(authenticate);

// --- Functions
app.get('/functions', wrap(async (req, res) => {
    res.json({ client: req.clientName, functions: await listFunctions(req.clientId) });
}));

// Body: raw JavaScript (text/plain) or JSON { code, timeoutMs?, memoryMb?, env?, connections? }
app.post('/functions/:name', upload.none(), wrap(async (req, res) => {
    const body = req.body;
    const isJson = body && typeof body === 'object';
    const code = isJson ? body.code : body;
    const created = await createFunction(req.clientId, req.params.name, code, isJson ? body : {});
    res.status(201).json({ message: 'Function created successfully', function: created.name, version: created.version });
}));

// Deploy a new version (same body formats as create)
app.put('/functions/:name', wrap(async (req, res) => {
    const code = req.body && typeof req.body === 'object' ? req.body.code : req.body;
    res.json({ message: 'New version deployed', ...(await deployVersion(req.clientId, req.params.name, code)) });
}));

app.get('/functions/:name', wrap(async (req, res) => res.json(await getFunction(req.clientId, req.params.name))));
app.get('/functions/:name/code', wrap(async (req, res) => {
    res.type('text/plain').send(await getFunctionCode(req.clientId, req.params.name));
}));

// { timeoutMs?, memoryMb?, env?: {K:"v"} (replaces all), connections?: ["name"] | null }
app.patch('/functions/:name/config', wrap(async (req, res) => {
    res.json(await updateConfig(req.clientId, req.params.name, req.body || {}));
}));

app.post('/functions/:name/rollback/:version', wrap(async (req, res) => {
    res.json(await rollback(req.clientId, req.params.name, Number(req.params.version)));
}));

app.get('/functions/:name/invocations', wrap(async (req, res) => {
    res.json({ invocations: await listInvocations(req.clientId, req.params.name, req.query.limit) });
}));

app.delete('/functions/:name', wrap(async (req, res) => {
    res.json({ message: 'Function deleted', ...(await deleteFunction(req.clientId, req.params.name)) });
}));

// --- Client-owned databases (usable from functions via context.getConnection(name))
app.get('/connections', wrap(async (req, res) => res.json({ connections: await listConnections(req.clientId) })));
app.put('/connections/:name', wrap(async (req, res) => {
    res.json(await upsertConnection(req.clientId, req.params.name, req.body));
}));
app.delete('/connections/:name', wrap(async (req, res) => {
    res.json({ message: 'Connection deleted', ...(await deleteConnection(req.clientId, req.params.name)) });
}));

// --- Invoke
app.post('/invoke/:name', wrap(async (req, res) => {
    const fn = await getInvokable(req.clientId, req.params.name);
    const { entry, dir } = await ensureEntry(fn);
    const connections = await resolveConnections(req.clientId, fn.connections);
    const env = fn.env_encrypted ? decryptJson(fn.env_encrypted, fn.id) : {};
    const requestId = uuidv4();

    let out, failure;
    try {
        out = await executeFunction({
            entry, entryDir: dir, event: req.body || {},
            timeoutMs: fn.timeout_ms, memoryMb: fn.memory_mb, env, connections,
            meta: { requestId, functionName: fn.name, version: fn.current_version }
        });
    } catch (err) {
        failure = err;
    }
    if (failure instanceof HttpError) throw failure; // e.g. 429, nothing ran

    recordInvocation({
        id: requestId, clientId: req.clientId, functionId: fn.id, functionName: fn.name,
        version: fn.current_version,
        status: failure ? (failure.code === 'TIMEOUT' ? 'timeout' : 'error') : 'success',
        durationMs: (out || failure).durationMs,
        error: failure ? failure.message : null,
        logs: (out || failure).logs
    }).catch((e) => console.error('Failed to record invocation:', e.message));

    res.set('X-Request-Id', requestId);
    if (failure) {
        const timeout = failure.code === 'TIMEOUT';
        return res.status(timeout ? 504 : 500).json({
            errorMessage: failure.message,
            errorType: timeout ? 'Timeout' : 'RuntimeError',
            requestId
        });
    }

    const result = out.result;
    // Support both Lambda-style and plain responses
    if (result && result.statusCode) return res.status(result.statusCode).json(result);
    res.json(result);
}));

// ========== Errors ==========
app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.code === '22P02') return res.status(400).json({ error: 'Invalid id format' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\nLocal Multi-Client FaaS running at http://localhost:${PORT}`);
    console.log(`Clients:  x-api-key: <key>      Admin: x-admin-key: <ADMIN_API_KEY>\n`);
});
