import express from 'express';
import multer from 'multer';
import { authenticate } from './auth.js';
import {
    listFunctions,
    getFunctionPath,
    createFunction,
    deleteFunction
} from './registry.js';
import { executeFunction } from './executor.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));

// ========== Protected Routes ==========
app.use(authenticate);

// List my functions
app.get('/functions', (req, res) => {
    const functions = listFunctions(req.userId);
    res.json({
        user: req.userName,
        functions
    });
});

// Create a new function
// Body: raw JavaScript code (text/plain) or JSON { "code": "..." }
app.post('/functions/:name', upload.none(), (req, res) => {
    try {
        const functionName = req.params.name;
        let code = req.body;

        // Support both raw text and JSON
        if (typeof code === 'object' && code.code) {
            code = code.code;
        }

        if (!code || typeof code !== 'string') {
            return res.status(400).json({ error: 'Function code is required' });
        }

        // Basic validation
        if (!code.includes('handler') && !code.includes('export')) {
            return res.status(400).json({ error: 'Code must export a handler' });
        }

        const result = createFunction(req.userId, functionName, code);
        res.status(201).json({
            message: 'Function created successfully',
            function: result.name
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Invoke a function
app.post('/invoke/:name', async (req, res) => {
    try {
        const functionPath = getFunctionPath(req.userId, req.params.name);
        const event = req.body || {};

        const result = await executeFunction(functionPath, event, 15000);

        // Support both Lambda-style and plain responses
        if (result && result.statusCode) {
            return res.status(result.statusCode).json(result);
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({
            errorMessage: err.message,
            errorType: 'RuntimeError'
        });
    }
});

// Delete a function
app.delete('/functions/:name', (req, res) => {
    try {
        const result = deleteFunction(req.userId, req.params.name);
        res.json({ message: 'Function deleted', ...result });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// Health check (public)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'Local FaaS' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\nLocal Multi-Client FaaS running at http://localhost:${PORT}`);
    console.log(`Use header: x-api-key: <your-key>\n`);
});