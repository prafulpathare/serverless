import { query } from './db.js';
import { sha256, safeEqual } from './crypto.js';

/** Client auth: x-api-key -> clients table (via hashed key). */
export async function authenticate(req, res, next) {
    try {
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) return res.status(401).json({ error: 'Missing x-api-key header' });

        const { rows } = await query(
            `select k.id as key_id, c.id as client_id, c.name, c.status
             from api_keys k join clients c on c.id = k.client_id
             where k.key_hash = $1 and k.revoked_at is null`,
            [sha256(apiKey)]
        );
        if (!rows.length) return res.status(403).json({ error: 'Invalid API key' });
        if (rows[0].status !== 'active') return res.status(403).json({ error: 'Client is suspended' });

        req.clientId = rows[0].client_id;
        req.clientName = rows[0].name;

        query('update api_keys set last_used_at = now() where id = $1', [rows[0].key_id]).catch(() => {});
        next();
    } catch (err) {
        next(err);
    }
}

/** Platform-operator auth for /admin/* */
export function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_API_KEY;
    const given = req.headers['x-admin-key'];
    if (!expected || !given || !safeEqual(given, expected)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}
