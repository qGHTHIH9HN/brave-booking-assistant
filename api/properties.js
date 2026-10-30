import pg from 'pg';
import { timingSafeEqual, randomUUID } from 'node:crypto';

const { Pool } = pg;
let pool;
function authorized(req) {
  const expected = process.env.DASHBOARD_ADMIN_KEY;
  const provided = (req.headers.authorization || '').replace(/^Bearer\\s+/i, '');
  if (!expected || !provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validListingUrl(value) {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.booking.com' && url.username === '' && url.password === '';
  } catch { return false; }
}
function parseBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body;
}
function cleanProperty(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.name !== 'string' || typeof body.url !== 'string' || typeof body.notes !== 'string') return null;
  const name = body.name.trim(), url = body.url.trim(), notes = body.notes.trim();
  if (!name || name.length > 200 || url.length > 1000 || notes.length > 2000 || !validListingUrl(url)) return null;
  return { name, url, notes };
}
async function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10000 });
  await pool.query(`CREATE TABLE IF NOT EXISTS managed_properties (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    url text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
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
  if (id && (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    return res.status(400).json({ error: 'Invalid property ID' });
  }
  try {
    const db = await database();
    if (req.method === 'GET') {
      if (id) {
        const { rows } = await db.query('SELECT * FROM managed_properties WHERE id=$1', [id]);
        return rows.length ? res.status(200).json(rows[0]) : res.status(404).json({ error: 'Not found' });
      }
      const { rows } = await db.query('SELECT * FROM managed_properties ORDER BY created_at DESC LIMIT 200');
      return res.status(200).json({ properties: rows });
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Property ID required' });
      const result = await db.query('DELETE FROM managed_properties WHERE id=$1 RETURNING id', [id]);
      return result.rowCount ? res.status(200).json({ deleted: id }) : res.status(404).json({ error: 'Not found' });
    }
    let property;
    try { property = cleanProperty(parseBody(req)); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!property) return res.status(400).json({ error: 'Provide name, url and notes; URL must be a Booking.com HTTPS listing' });
    if (req.method === 'POST') {
      if (id) return res.status(400).json({ error: 'Do not provide ID when creating' });
      const { rows } = await db.query(
        'INSERT INTO managed_properties (id,name,url,notes) VALUES ($1,$2,$3,$4) RETURNING *',
        [randomUUID(), property.name, property.url, property.notes]
      );
      return res.status(201).json(rows[0]);
    }
    if (!id) return res.status(400).json({ error: 'Property ID required' });
    const { rows } = await db.query(
      'UPDATE managed_properties SET name=$2,url=$3,notes=$4,updated_at=now() WHERE id=$1 RETURNING *',
      [id, property.name, property.url, property.notes]
    );
    return rows.length ? res.status(200).json(rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (error) {
    console.error('properties API failure', error.message);
    return res.status(500).json({ error: 'Database request failed' });
  }
}
