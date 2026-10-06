# Local Multi-Client FaaS (Lambda-like Runtime)

A lightweight, self-hosted **Function-as-a-Service** platform inspired by AWS Lambda.  
It lets multiple clients create, manage, and invoke **Node.js** functions with isolation, timeouts, and API-key authentication — all running on your own machine (or any server).

---

## Features

- **Multi-client / Multi-tenant** support
- Each client has completely isolated functions
- API Key authentication
- Create, list, invoke, and delete functions via HTTP API
- Functions written in standard Lambda style (`export const handler = async (event, context) => {}`)
- Process isolation using Node.js `child_process.fork`
- Configurable timeout per invocation
- Works on Windows, macOS, and Linux
- Extremely lightweight — perfect for a 16 GB laptop
- No external database needed (filesystem-based storage)

---

## Project Structure

```
serverless/
├── package.json
├── server.js              # Main HTTP server + routes
├── auth.js                # API Key authentication
├── registry.js            # Function storage & management (per user)
├── executor.js            # Spawns isolated child processes
├── worker.js              # Runs inside the child process
├── users.json             # Client registry (API keys)
└── functions/             # Auto-created
    ├── user_abc123/
    │   └── hello/
    │       └── index.js
    └── user_xyz789/
        └── ...
```

---

## Prerequisites

- **Node.js** ≥ 18 (recommended: 20 or 22)
- npm or yarn

---

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/my-local-faas.git
cd my-local-faas

npm install
```

---

## Configuration

### 1. Create clients (`users.json`)

```json
{
  "clients": {
    "user_abc123": {
      "name": "Client A",
      "apiKey": "sk_live_abc123xyz"
    },
    "user_xyz789": {
      "name": "Client B",
      "apiKey": "sk_live_xyz789uvw"
    }
  }
}
```

- Each client gets a unique `userId` (folder name) and an `apiKey`.
- Clients can **only** see and manage their own functions.

### 2. Start the server

```bash
npm start
# or for development (auto-restart)
npm run dev
```

Server runs at: `http://localhost:3000`

---

## API Reference

All protected endpoints require the header:

```
x-api-key: <your-api-key>
```

### Health Check (public)

```http
GET /health
```

### List my functions

```http
GET /functions
```

**Response**
```json
{
  "user": "Client A",
  "functions": ["hello", "math"]
}
```

### Create a function

```http
POST /functions/:name
Content-Type: text/plain   (or application/json with { "code": "..." })
```

**Example**
```bash
curl -X POST http://localhost:3000/functions/hello \
  -H "x-api-key: sk_live_abc123xyz" \
  -H "Content-Type: text/plain" \
  -d '
export const handler = async (event, context) => {
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Hello from your own FaaS!",
      input: event,
      requestId: context.awsRequestId
    })
  };
};
'
```

### Invoke a function

```http
POST /invoke/:name
Content-Type: application/json
```

**Example**
```bash
curl -X POST http://localhost:3000/invoke/hello \
  -H "x-api-key: sk_live_abc123xyz" \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe"}'
```

### Delete a function

```http
DELETE /functions/:name
```

---

## Writing Functions

Functions must export a `handler`:

```js
export const handler = async (event, context) => {
  // event   → the JSON body you sent
  // context → { awsRequestId, functionName, memoryLimitInMB, getRemainingTimeInMillis }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Success", data: event })
  };

  // You can also return plain objects — the server will wrap them
};
```

---

## Architecture Overview

```
Client ──► Auth Middleware ──► Router
                                  │
                                  ▼
                           Function Registry
                           (per-user folders)
                                  │
                                  ▼
                             Executor
                      (forks a new Node process)
                                  │
                                  ▼
                              worker.js
                     (loads & runs the handler)
```

- Every invocation runs in a **fresh child process** → good isolation.
- Timeout is enforced by killing the child process.
- No shared memory between functions or clients.

---

## Windows Note

Dynamic `import()` of absolute paths fails on Windows (`D:\...` is treated as a protocol).  
This project already handles it correctly by converting paths to `file://` URLs using `pathToFileURL`.

---

## Future Improvements (Ideas)

- [ ] Per-function configuration (`timeout`, `memory`, `env` variables)
- [ ] Capture and return `console.log` / `console.error` from functions
- [ ] Warm process pool for lower latency
- [ ] Simple admin API to create/revoke clients
- [ ] Function versioning
- [ ] Rate limiting per client
- [ ] Optional Docker-based isolation for stronger sandboxing
- [ ] Web UI dashboard

---

## Security Notes

- This is designed for **trusted environments** or private networks.
- API keys are currently stored in plain text (`users.json`).
- There is no request size limit beyond Express defaults (currently 2 MB).
- Child processes inherit the parent environment — be careful with secrets.
- For production use, consider adding:
  - HTTPS
  - Proper secret management
  - Resource limits (`ulimit`, cgroups, or containers)
  - Input validation / sanitization

---

## License

MIT

---

## Contributing

Pull requests and ideas are welcome!  
Feel free to open issues for bugs or feature requests.
