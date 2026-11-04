import pg from 'pg';
import crypto from 'node:crypto';
import {valid as validOAuth} from './oauth.js';
import {BROWSER_ACTIONS,validateBrowserCommand} from './browser-command-utils.js';
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
const allowed=new Set(['open_listing','inspect_active','start_booking','book_now','resume_booking','inspect_booking','confirm_booking',...BROWSER_ACTIONS]);
// Separate scoped token; intentionally do not fall back to dashboard admin credentials.
const reply=(res,code,body)=>{res.setHeader('Cache-Control','no-store');return res.status(code).json(body)};
function authorized(req){
 const bearer=(req.headers.authorization||'').replace(/^Bearer /i,'');
 const staticToken=process.env.EXTENSION_COMMAND_TOKEN||'';
 if(staticToken&&bearer.length===staticToken.length&&crypto.timingSafeEqual(Buffer.from(bearer),Buffer.from(staticToken)))return true;
 // Scoped pairing tokens can only retrieve and acknowledge commands.
 // They are never authorized to insert commands into the queue.
 const paired=validOAuth(bearer,'extension');
 return paired?.scope==='command:poll'&&(req.method==='GET'||req.method==='PATCH');
}
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
   if(JSON.stringify(payload).length>2500)return reply(res,400,{error:'Command too large'});
   if(action==='start_booking'||action==='book_now'){
    let u;try{u=new URL(payload.url)}catch{return reply(res,400,{error:'Invalid hotel URL'})}
    if(u.protocol!=='https:'||u.hostname!=='www.booking.com'||!/^\/hotel\/ma\/[a-z0-9-]+\.en-gb\.html$/.test(u.pathname)||u.username||u.password)return reply(res,400,{error:'Only Morocco hotel listing URLs allowed'});
    const dt=/^\d{4}-\d{2}-\d{2}$/;
    const a=new Date(String(payload.checkin)+'T00:00:00Z'),b=new Date(String(payload.checkout)+'T00:00:00Z');
    if(!dt.test(payload.checkin)||!dt.test(payload.checkout)||!Number.isFinite(+a)||!Number.isFinite(+b)||b<=a||b-a>30*86400000)return reply(res,400,{error:'Invalid stay dates'});
    if(!Number.isInteger(payload.adults)||payload.adults<1||payload.adults>8||typeof payload.roomType!=='string'||payload.roomType.length>80)return reply(res,400,{error:'Invalid guest count or room type'});
    if(typeof payload.maxTotal!=='number'||!Number.isFinite(payload.maxTotal)||payload.maxTotal<=0||payload.maxTotal>100000||!['EUR','MAD','GBP','USD'].includes(payload.currency))return reply(res,400,{error:'Maximum total and currency required'});
    if(payload.guestIndex!==undefined&&(!Number.isInteger(payload.guestIndex)||payload.guestIndex<1||payload.guestIndex>1000))return reply(res,400,{error:'Guest selection index must be 1–1000'});
    const safeFields=['url','checkin','checkout','adults','roomType','maxTotal','currency','guestIndex','vpnCountry'];
    if(action==='book_now'){
      if(payload.authorization!=='submit_this_booking'||!Number.isSafeInteger(payload.authorizedAt)||payload.authorizedAt>Date.now()+2*60*1000||Date.now()-payload.authorizedAt>20*60*1000)
        return reply(res,400,{error:'Book now needs a fresh explicit submission authorization'});
      if(typeof payload.maxCancellationCharge!=='number'||!Number.isFinite(payload.maxCancellationCharge)||payload.maxCancellationCharge<0||payload.maxCancellationCharge>100000||!['EUR','MAD','USD','GBP'].includes(payload.cancellationCurrency))
        return reply(res,400,{error:'Book now needs a cancellation ceiling and currency'});
      if(!payload.roomType.trim())return reply(res,400,{error:'Book now needs an exact room type'});
    }
    if(payload.vpnCountry!==undefined&&(typeof payload.vpnCountry!=='string'||!/^(?:[A-Z]{2}|AUTO)$/.test(payload.vpnCountry)))return reply(res,400,{error:'VPN must be AUTO or a two-letter ISO country code'});
    const extra=action==='book_now'?['authorization','authorizedAt','maxCancellationCharge','cancellationCurrency']:[];
    if(Object.keys(payload).some(k=>![...safeFields,...extra].includes(k)))return reply(res,400,{error:'Unexpected field; guest identities must remain local to Brave'});
   }else if(BROWSER_ACTIONS.includes(action)){
    let validated;try{validated=validateBrowserCommand({action,...payload})}catch(e){return reply(res,400,{error:e.message})}
    if(JSON.stringify(validated.payload)!==JSON.stringify(payload))return reply(res,400,{error:'Unexpected browser payload shape'});
   }else if(!['open_listing'].includes(action)&&Object.keys(payload).length)return reply(res,400,{error:'This action takes no payload'});
   const r=await db().query('INSERT INTO extension_commands (action,payload) VALUES ($1,$2::jsonb) RETURNING id,action,status,created_at',[action,JSON.stringify(payload)]);
   return reply(res,201,{command:r.rows[0]});
  }
  if(req.method==='GET'){
   // Non-destructive connectivity probe: do not consume any queued command.
   if(String(req.query?.health||'')==='1'){
    const r=await db().query("SELECT COUNT(*)::integer AS pending FROM extension_commands WHERE status='pending'");
    return reply(res,200,{service:'ready',queue_pending:r.rows[0]?.pending??0,commands_supported:true});
   }
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