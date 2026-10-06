import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.join(__dirname, 'functions');

// Ensure base directory exists
if (!fs.existsSync(FUNCTIONS_DIR)) {
    fs.mkdirSync(FUNCTIONS_DIR);
}

export function getUserDir(userId) {
    const dir = path.join(FUNCTIONS_DIR, userId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

export function listFunctions(userId) {
    const userDir = getUserDir(userId);
    return fs.readdirSync(userDir).filter(name => {
        return fs.statSync(path.join(userDir, name)).isDirectory();
    });
}

export function getFunctionPath(userId, functionName) {
    const funcDir = path.join(getUserDir(userId), functionName);
    const indexPath = path.join(funcDir, 'index.js');

    if (!fs.existsSync(indexPath)) {
        throw new Error(`Function "${functionName}" not found`);
    }
    return indexPath;
}

export function createFunction(userId, functionName, code) {
    const funcDir = path.join(getUserDir(userId), functionName);

    if (fs.existsSync(funcDir)) {
        throw new Error(`Function "${functionName}" already exists`);
    }

    fs.mkdirSync(funcDir, { recursive: true });
    fs.writeFileSync(path.join(funcDir, 'index.js'), code, 'utf8');

    return { name: functionName, path: funcDir };
}

export function deleteFunction(userId, functionName) {
    const funcDir = path.join(getUserDir(userId), functionName);

    if (!fs.existsSync(funcDir)) {
        throw new Error(`Function "${functionName}" not found`);
    }

    fs.rmSync(funcDir, { recursive: true, force: true });
    return { deleted: functionName };
}