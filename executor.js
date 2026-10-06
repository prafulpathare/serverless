import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function executeFunction(functionPath, event, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const workerPath = path.join(__dirname, 'worker.js');

        const child = fork(workerPath, [], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env }
        });

        const requestId = uuidv4();
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                child.kill('SIGKILL');
                reject(new Error(`Function timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        child.on('message', (msg) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);

            if (msg.error) {
                reject(new Error(msg.error));
            } else {
                resolve(msg.result);
            }
            child.kill();
        });

        child.on('error', (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(err);
        });

        child.on('exit', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Function process exited with code ${code}`));
            }
        });

        child.send({
            functionPath,
            event,
            context: {
                awsRequestId: requestId,
                functionName: path.basename(path.dirname(functionPath)),
                memoryLimitInMB: 128,
                getRemainingTimeInMillis: () => timeoutMs
            }
        });
    });
}