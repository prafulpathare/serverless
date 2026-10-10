import crypto from 'crypto';

const hex = process.env.ENCRYPTION_KEY || '';
console.warn('ENCRYPTION_KEY',hex);
// if (!/^[0-9a-f]{64}$/i.test(hex)) {
//     throw new Error('ENCRYPTION_KEY must be 64 hex chars. Generate one with: openssl rand -hex 32');
// }
const KEY = Buffer.from(hex, 'hex');

/**
 * AES-256-GCM. `aad` (e.g. the owning client/function id) is authenticated, so a ciphertext
 * copied into another row will fail to decrypt.
 */
export function encryptJson(obj, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    cipher.setAAD(Buffer.from(String(aad)));
    const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
        .join(':');
}

export function decryptJson(payload, aad) {
    const [version, iv, tag, ct] = payload.split(':');
    if (version !== 'v1') throw new Error('Unknown ciphertext version');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(String(aad)));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function generateApiKey() {
    const plain = 'sk_live_' + crypto.randomBytes(24).toString('base64url');
    return { plain, prefix: plain.slice(0, 12), hash: sha256(plain) };
}

export function safeEqual(a, b) {
    return crypto.timingSafeEqual(
        crypto.createHash('sha256').update(String(a)).digest(),
        crypto.createHash('sha256').update(String(b)).digest()
    );
}
