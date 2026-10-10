import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { HttpError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, 'worker.js');

const MAX_ACTIVE = Number(process.env.MAX_CONCURRENT_EXECUTIONS) || 20;
const MAX_LOG_BYTES = 64 * 1024;
const SANDBOX_MODE = process.env.SANDBOX_MODE || 'none';
let active = 0;

function sandboxArgs(entryDir) {
    if (SANDBOX_MODE !== 'permission') return [];
    const major = Number(process.versions.node.split('.')[0]);
    return [
        major >= 24 ? '--permission' : '--experimental-permission',
        `--allow-fs-read=${workerPath}`,
        `--allow-fs-read=${path.join(__dirname, 'package.json')}`,
        `--allow-fs-read=${path.join(__dirname, 'node_modules')}`,
        `--allow-fs-read=${entryDir}` // only this function's own code; no writes, no child_process
    ];
}

/**
 * Run one invocation in a throw-away child process.
 * The child gets a minimal env: NOT the platform's env (DATABASE_URL, ENCRYPTION_KEY, ...).
 */
export async function executeFunction({ entry, entryDir, event, timeoutMs, memoryMb, env = {}, connections = [], meta }) {
    if (active >= MAX_ACTIVE) throw new HttpError(429, 'Too many concurrent executions, retry shortly');
    active++;

    const requestId = meta.requestId || uuidv4();
    const started = Date.now();

    const childEnv = {
        PATH: process.env.PATH,
        ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }),
        NODE_ENV: 'production',
        AWS_LAMBDA_FUNCTION_NAME: meta.functionName,
        AWS_LAMBDA_FUNCTION_VERSION: String(meta.version),
        AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(memoryMb),
        ...env // client-defined variables
    };

    return new Promise((resolve, reject) => {
        let logs = '';
        let finished = false;
        let payload = null;

        const child = fork(workerPath, [], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            cwd: entryDir,
            env: childEnv,
            // explicit execArgv: don't inherit --watch etc. from the platform process
            execArgv: [`--max-old-space-size=${memoryMb}`, ...sandboxArgs(entryDir)]
        });

        const collect = (chunk) => {
            if (logs.length < MAX_LOG_BYTES) logs += chunk.toString().slice(0, MAX_LOG_BYTES - logs.length);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        const settle = (err, result) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            active--;
            const durationMs = Date.now() - started;
            if (err) return reject(Object.assign(err, { logs, durationMs, requestId }));
            resolve({ result, logs, durationMs, requestId });
        };

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            settle(Object.assign(new Error(`Function timed out after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
        }, timeoutMs);

        child.on('message', (msg) => { payload = msg; });
        child.on('error', (err) => settle(err));

        // 'close' fires after stdio is drained, so logs are complete
        child.on('close', (code, signal) => {
            if (finished) return;
            if (payload?.error) return settle(new Error(payload.error));
            if (payload) return settle(null, payload.result);
            settle(new Error(
                signal === 'SIGABRT' || code === 134
                    ? 'Function ran out of memory'
                    : `Function process exited unexpectedly (code ${code}, signal ${signal})`
            ));
        });

        child.send({
            entry,
            event,
            connections, // decrypted configs, handed over IPC only (never env, never disk)
            context: {
                awsRequestId: requestId,
                functionName: meta.functionName,
                functionVersion: meta.version,
                memoryLimitInMB: memoryMb,
                timeoutMs
            }
        });
    });
}
