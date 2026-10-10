import pg from 'pg';

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (see .env.example)');
}

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? true : undefined,
    max: 10
});

pool.on('error', (err) => console.error('Master DB pool error:', err.message));

export const query = (text, params) => pool.query(text, params);

/** Run fn(q) inside a transaction. q(text, params) uses the transaction's connection. */
export async function tx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn((text, params) => client.query(text, params));
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}
