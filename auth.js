import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const usersFile = path.join(__dirname, 'users.json');

export function loadUsers() {
    if (!fs.existsSync(usersFile)) {
        fs.writeFileSync(usersFile, JSON.stringify({ clients: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
}

export function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'Missing x-api-key header' });
    }

    const users = loadUsers();
    const client = Object.entries(users.clients).find(
        ([, data]) => data.apiKey === apiKey
    );

    if (!client) {
        return res.status(403).json({ error: 'Invalid API key' });
    }

    req.userId = client[0]; // e.g. "user_abc123"
    req.userName = client[1].name;
    next();
}