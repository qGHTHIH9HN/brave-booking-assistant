import pg from 'pg';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;
let pool;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function authorized(req) {
  const expected = process.env.DASHBOARD_ADMIN_KEY;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function encryptionKey() {
  const raw = process.env.GUEST_DATA_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) throw new Error('Guest encryption key not configured');
  return Buffer.from(raw, 'hex');
}
function encrypt(record) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function decrypt(value) {
  const data = Buffer.from(value, 'base64');
  if (data.length < 29) throw new Error('Invalid ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { full_name, email, phone, notes, consent_confirmed } = value;
  if (typeof full_name !== 'string' || typeof email !== 'string' || typeof phone !== 'string' || typeof notes !== 'string' || consent_confirmed !== true) return null;
  const name = full_name.trim(), mail = email.trim(), tel = phone.trim(), memo = notes.trim();
  if (!name || name.length > 200 || mail.length > 254 || tel.length > 50 || memo.length > 1000) return null;
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return null;
  return { full_name: name, email: mail, phone: tel, notes: memo };
}
async function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 10000 });
  await pool.query(`CREATE TABLE IF NOT EXISTS managed_guests (
    id uuid PRIMARY KEY,
    encrypted_data text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  return pool;
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query?.id;
  if (id && (typeof id !== 'string' || !uuid.test(id))) return res.status(400).json({ error: 'Invalid guest ID' });
  try {
    encryptionKey();
    const conn = await db();
    if (req.method === 'GET') {
      if (!id) return res.status(400).json({ error: 'Guest ID required; bulk PII export disabled' });
      const { rows } = await conn.query('SELECT * FROM managed_guests WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ id: rows[0].id, ...decrypt(rows[0].encrypted_data), created_at: rows[0].created_at, updated_at: rows[0].updated_at });
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Guest ID required' });
      const { rows } = await conn.query('DELETE FROM managed_guests WHERE id=$1 RETURNING id', [id]);
      return rows.length ? res.status(200).json({ deleted: id }) : res.status(404).json({ error: 'Not found' });
    }
    let guest;
    try { guest = validate(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!guest) return res.status(400).json({ error: 'Invalid guest fields or missing consent confirmation' });
    const ciphertext = encrypt(guest);
    if (req.method === 'POST') {
      if (id) return res.status(400).json({ error: 'ID not allowed on create' });
      const { rows } = await conn.query('INSERT INTO managed_guests(id,encrypted_data) VALUES ($1,$2) RETURNING id,created_at,updated_at', [randomUUID(), ciphertext]);
      return res.status(201).json(rows[0]);
    }
    if (!id) return res.status(400).json({ error: 'Guest ID required' });
    const { rows } = await conn.query('UPDATE managed_guests SET encrypted_data=$2,updated_at=now() WHERE id=$1 RETURNING id,created_at,updated_at', [id, ciphertext]);
    return rows.length ? res.status(200).json(rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (error) {
    console.error('guests API failure', error.message);
    return res.status(500).json({ error: 'Guest request failed or configuration missing' });
  }
}
