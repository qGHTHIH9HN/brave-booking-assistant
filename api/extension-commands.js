import pg from 'pg';
import crypto from 'node:crypto';
// Preview must use the isolated staging branch, never the production DATABASE_URL.
const isProduction=process.env.VERCEL_ENV==='production';
const connectionString=isProduction?process.env.DATABASE_URL:process.env.STAGING_DATABASE_URL;
let pool;
function db(){
 if(!connectionString)throw new Error('Command database is not configured for this environment');
 if(!pool){
  let url;
  try{url=new URL(connectionString)}catch{throw Object.assign(new Error('Invalid staging database URL format'),{code:'CONFIG_URL_INVALID'})}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.pathname||url.pathname==='/')throw Object.assign(new Error('Staging database URL must be a PostgreSQL connection string'),{code:'CONFIG_URL_INVALID'});
  pool=new pg.Pool({connectionString,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:8000});
 }

 return pool;
}
const allowed=new Set(['open_listing','inspect_active']);
// Separate scoped token; intentionally do not fall back to dashboard admin credentials.
const reply=(res,code,body)=>{res.setHeader('Cache-Control','no-store');return res.status(code).json(body)};
function authorized(req){const a=(req.headers.authorization||'').replace(/^Bearer /i,'');const b=process.env.EXTENSION_COMMAND_TOKEN||'';return !!b&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b))}
export default async function handler(req,res){
 if(!authorized(req))return reply(res,401,{error:'Unauthorized'});
 try{
  if(req.method==='POST'){
   const {action,payload}=req.body||{};
   if(!allowed.has(action)||!payload||typeof payload!=='object'||Array.isArray(payload))return reply(res,400,{error:'Invalid command'});
   if(action==='open_listing'){
    let u;try{u=new URL(payload.url)}catch{return reply(res,400,{error:'Invalid URL'})}
    if(u.protocol!=='https:'||u.hostname!=='www.booking.com'||!/^\/hotel\/ma\/[a-z0-9-]+\.en-gb\.html$/.test(u.pathname))return reply(res,400,{error:'Only Booking.com Morocco listings allowed'});
   }
   const r=await db().query('INSERT INTO extension_commands (action,payload) VALUES ($1,$2::jsonb) RETURNING id,action,status,created_at',[action,JSON.stringify(payload)]);
   return reply(res,201,{command:r.rows[0]});
  }
  if(req.method==='GET'){
   if(req.query?.id){
    if(!/^\d+$/.test(String(req.query.id)))return reply(res,400,{error:'Invalid id'});
    const r=await db().query('SELECT id,action,status,result,created_at,finished_at FROM extension_commands WHERE id=$1',[req.query.id]);
    return reply(res,200,{command:r.rows[0]||null});
   }
   const r=await db().query("UPDATE extension_commands SET status='claimed',claimed_at=now() WHERE id=(SELECT id FROM extension_commands WHERE status='pending' OR (status='claimed' AND claimed_at < now()-interval '3 minutes') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,action,payload");
   return reply(res,200,{command:r.rows[0]||null});
  }
  if(req.method==='PATCH'){
   const {id,result}=req.body||{};
   if(!Number.isSafeInteger(id)||!result||typeof result!=='object'||JSON.stringify(result).length>12000)return reply(res,400,{error:'Invalid result'});
   const r=await db().query("UPDATE extension_commands SET status='completed',result=$1::jsonb,finished_at=now() WHERE id=$2 AND status='claimed' RETURNING id,status",[JSON.stringify(result),id]);
   return reply(res,r.rowCount?200:404,{command:r.rows[0]||null});
  }
  res.setHeader('Allow','GET, POST, PATCH');return reply(res,405,{error:'Method not allowed'});
 }catch(e){console.error('extension commands',e.code||'NO_CODE',e.message,'type',e.constructor?.name,'stack',String(e.stack||'').split('\\n').slice(0,5).join(' | '));
  const code=e.code==='CONFIG_URL_INVALID'?'staging_database_url_invalid':e.code==='28P01'?'staging_database_auth_failed':e.code==='42P01'?'staging_table_missing':e.code==='ENOTFOUND'?'staging_database_host_unreachable':e.message==='Invalid JSON'?'staging_database_invalid_json':'staging_database_connection_failed';
  return reply(res,500,{error:'Command service unavailable',reason:code})}
}