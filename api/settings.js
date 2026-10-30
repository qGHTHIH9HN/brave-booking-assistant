import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
const { Pool } = pg;
let pool;
function authorized(req) {
 const expected = process.env.DASHBOARD_ADMIN_KEY;
 const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
 if (!expected || !given) return false;
 const a=Buffer.from(given), b=Buffer.from(expected);
 return a.length === b.length && timingSafeEqual(a,b);
}
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 if (!authorized(req)) return res.status(401).json({error:'Unauthorized. Check administrator key.'});
 if (!['GET','PUT'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
 if (!process.env.DATABASE_URL) return res.status(503).json({error:'DATABASE_URL is not configured'});
 try {
  pool ||= new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:2,connectionTimeoutMillis:10000});
  await pool.query(`CREATE TABLE IF NOT EXISTS assistant_settings (id integer PRIMARY KEY CHECK (id=1), property text NOT NULL DEFAULT '', url text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now())`);
  if(req.method==='GET') {
   const {rows}=await pool.query('SELECT property,url,notes,updated_at FROM assistant_settings WHERE id=1');
   return res.status(200).json(rows[0]||{property:'',url:'',notes:''});
  }
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
  if (!body || ['property','url','notes'].some(k=>typeof body[k]!=='string')) return res.status(400).json({error:'Invalid fields'});
  const {property,url,notes}=body;
  if(property.length>200 || url.length>1000 || notes.length>2000) return res.status(400).json({error:'Input too long'});
  if(url && (!/^https:\/\/www\.booking\.com\//i.test(url) || !/^https:\/\/www\.booking\.com\//i.test(new URL(url).href))) return res.status(400).json({error:'Use a https://www.booking.com/ listing URL'});
  const {rows}=await pool.query(`INSERT INTO assistant_settings(id,property,url,notes) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET property=EXCLUDED.property,url=EXCLUDED.url,notes=EXCLUDED.notes,updated_at=now() RETURNING property,url,notes,updated_at`,[property.trim(),url.trim(),notes.trim()]);
  return res.status(200).json(rows[0]);
 } catch(e) {console.error('settings API failure',e.message);return res.status(500).json({error:'Database request failed. Check deployment logs.'});}
}
