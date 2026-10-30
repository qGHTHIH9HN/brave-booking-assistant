import pg from 'pg';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;
let pool;
const statuses = new Set(['draft', 'pending_review', 'cancelled', 'completed']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function authorized(req) {
  const key = process.env.DASHBOARD_ADMIN_KEY;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!key || !token) return false;
  const a = Buffer.from(token), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
function dateOk(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { property_id, check_in, check_out, status, notes } = input;
  if (typeof property_id !== 'string' || !uuid.test(property_id)) return null;
  if (!dateOk(check_in) || !dateOk(check_out) || check_out <= check_in) return null;
  if (!statuses.has(status) || typeof notes !== 'string' || notes.length > 2000) return null;
  return { property_id, check_in, check_out, status, notes: notes.trim() };
}
async function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 10000 });
  await pool.query(`CREATE TABLE IF NOT EXISTS managed_bookings (
    id uuid PRIMARY KEY,
    property_id uuid NOT NULL REFERENCES managed_properties(id) ON DELETE RESTRICT,
    check_in date NOT NULL,
    check_out date NOT NULL,
    status text NOT NULL CHECK (status IN ('draft','pending_review','cancelled','completed')),
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (check_out > check_in)
  )`);
  return pool;
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const id = req.query?.id;
  if (id && (typeof id !== 'string' || !uuid.test(id))) return res.status(400).json({ error: 'Invalid booking ID' });
  try {
    const conn = await db();
    if (req.method === 'GET') {
      if (id) {
        const { rows } = await conn.query('SELECT * FROM managed_bookings WHERE id=$1', [id]);
        return rows.length ? res.status(200).json(rows[0]) : res.status(404).json({ error: 'Not found' });
      }
      const { rows } = await conn.query('SELECT * FROM managed_bookings ORDER BY created_at DESC LIMIT 200');
      return res.status(200).json({ bookings: rows });
    }
    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'Booking ID required' });
      const { rows } = await conn.query('DELETE FROM managed_bookings WHERE id=$1 RETURNING id', [id]);
      return rows.length ? res.status(200).json({ deleted: id }) : res.status(404).json({ error: 'Not found' });
    }
    let data;
    try { data = validate(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!data) return res.status(400).json({ error: 'Invalid booking fields' });
    if (req.method === 'POST') {
      if (id) return res.status(400).json({ error: 'ID is not allowed when creating' });
      const { rows } = await conn.query(
        'INSERT INTO managed_bookings(id,property_id,check_in,check_out,status,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [randomUUID(), data.property_id, data.check_in, data.check_out, data.status, data.notes]
      );
      return res.status(201).json(rows[0]);
    }
    if (!id) return res.status(400).json({ error: 'Booking ID required' });
    const { rows } = await conn.query(
      'UPDATE managed_bookings SET property_id=$2,check_in=$3,check_out=$4,status=$5,notes=$6,updated_at=now() WHERE id=$1 RETURNING *',
      [id, data.property_id, data.check_in, data.check_out, data.status, data.notes]
    );
    return rows.length ? res.status(200).json(rows[0]) : res.status(404).json({ error: 'Not found' });
  } catch (error) {
    if (error.code === '23503') return res.status(400).json({ error: 'Property does not exist' });
    console.error('bookings API failure', error.message);
    return res.status(500).json({ error: 'Database request failed' });
  }
}
