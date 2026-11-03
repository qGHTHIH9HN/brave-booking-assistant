import crypto from 'node:crypto';
import pg from 'pg';
let pool;
const database=()=>pool||(pool=new pg.Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:8000}));
async function codeStore(){const d=database();await d.query('CREATE TABLE IF NOT EXISTS oauth_codes (code_hash text PRIMARY KEY, expires_at timestamptz NOT NULL)');return d;}
async function clientStore(){const d=database();await d.query('CREATE TABLE IF NOT EXISTS oauth_clients (id_hash text PRIMARY KEY, redirect_uris jsonb NOT NULL, expires_at timestamptz NOT NULL)');return d;}
const clientHash=(s)=>crypto.createHash('sha256').update(s).digest('hex');
async function registerClient(redirects){
 const d=await clientStore();
 const id='brave_'+crypto.randomBytes(32).toString('base64url');
 await d.query("INSERT INTO oauth_clients(id_hash,redirect_uris,expires_at) VALUES($1,$2::jsonb,now()+interval '30 days')",[clientHash(id),JSON.stringify(redirects)]);
 return id;
}
async function lookupClient(id){
 if(typeof id!=='string'||id.length<1||id.length>4096)return null;
 const d=await clientStore();
 const row=await d.query('SELECT redirect_uris FROM oauth_clients WHERE id_hash=$1 AND expires_at>now()',[clientHash(id)]);
 const redirects=row.rows[0]?.redirect_uris;
 if(Array.isArray(redirects)&&redirects.every(isAllowedRedirect))return {kind:'client',redirects};
 return valid(id,'client');
}
const origin=req=>`https://${req.headers.host}`;
const secret=()=>process.env.MCP_BRIDGE_TOKEN||'';
const h=(s)=>crypto.createHmac('sha256',secret()).update(s).digest('base64url');
const b=(x)=>Buffer.from(JSON.stringify(x)).toString('base64url');
const unb=(s)=>JSON.parse(Buffer.from(s,'base64url').toString());
export const valid=(s,kind)=>{if(!secret()||!s)return null;const parts=s.split('.');if(parts.length!==2)return null;const expected=h(parts[0]);if(parts[1].length!==expected.length||!crypto.timingSafeEqual(Buffer.from(parts[1]),Buffer.from(expected)))return null;try{const p=unb(parts[0]);return p.kind===kind&&p.exp>Date.now()?p:null}catch{return null}};
export const sign=(p)=>{const s=b(p);return s+'.'+h(s)};
const json=(res,status,data)=>res.status(status).json(data);
function parsedBody(req){
 const body=req.body;
 if(body&&typeof body==='object'&&!Buffer.isBuffer(body)&&!Array.isArray(body))return body;
 if(body===undefined||body===null)return {};
 const value=Buffer.isBuffer(body)?body.toString('utf8'):String(body);
 if(value.length>16384)return {};
 try{
  if(String(req.headers['content-type']||'').includes('application/json'))return JSON.parse(value);
  return Object.fromEntries(new URLSearchParams(value));
 }catch{return {}}
}
const isAllowedRedirect=(u)=>{try{const x=new URL(u);return x.protocol==='https:'&&!x.username&&!x.password&&x.hash===''||x.protocol==='http:'&&['localhost','127.0.0.1'].includes(x.hostname)}catch{return false}};
const isChatGPTCallback=(u)=>{try{
 const x=new URL(u);
 return x.origin==='https://chatgpt.com'&&!x.username&&!x.password&&!x.search&&!x.hash&&
   (x.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[A-Za-z0-9_-]{1,256}$/.test(x.pathname));
}catch{return false}};
function legacyChatGPTClient(id,redirect){
 // Recovered claim data are untrusted. Only a successful owner-token challenge can persist this registration.
 if(typeof id!=='string'||id.length>4096||!isChatGPTCallback(redirect)||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(id))return null;
 try{
  const p=unb(id.split('.')[0]),now=Date.now();
  if(p.kind!=='client'||!Number.isFinite(p.exp)||p.exp<=now||p.exp>now+32*86400000)return null;
  if(!Array.isArray(p.redirects)||p.redirects.length<1||p.redirects.length>5||!p.redirects.every(isChatGPTCallback)||!p.redirects.includes(redirect))return null;
  return {kind:'client',redirects:[redirect]};
 }catch{return null}
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(process.env.VERCEL_ENV==='production')return json(res,404,{error:'not_found'});
 if(!secret())return json(res,503,{error:'oauth_not_configured'});
 const route=req.query?.route||'';
 const path=route==='metadata'? '/.well-known/oauth-authorization-server':route==='resource'? '/.well-known/oauth-protected-resource': '/api/oauth/'+route;
 const base=origin(req);
 if(path.endsWith('/.well-known/oauth-protected-resource'))return json(res,200,{resource:base+'/api/mcp',authorization_servers:[base]});
 if(path.endsWith('/.well-known/oauth-authorization-server'))return json(res,200,{issuer:base,authorization_endpoint:base+'/api/oauth/authorize',token_endpoint:base+'/api/oauth/token',registration_endpoint:base+'/api/oauth/register',response_types_supported:['code'],grant_types_supported:['authorization_code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['brave:read','brave:control','brave:book']});
 if(path.endsWith('/register')){
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const a=parsedBody(req);if(!Array.isArray(a.redirect_uris)||a.redirect_uris.length<1||a.redirect_uris.length>5||!a.redirect_uris.every(isAllowedRedirect))return json(res,400,{error:'invalid_redirect_uri'});
  let id;
  try{id=await registerClient(a.redirect_uris)}catch(e){console.error('oauth client registration storage',e.code||e.name);return json(res,503,{error:'temporarily_unavailable',reason:'client_registration_storage_unavailable'})}
  return json(res,201,{client_id:id,client_name:a.client_name||'ChatGPT MCP',redirect_uris:a.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']});
 }
 if(path.endsWith('/authorize')){
  const a=req.method==='POST'?parsedBody(req):(req.query||{});
  let client;
  try{client=await lookupClient(a.client_id)}catch(e){console.error('oauth client lookup storage',e.code||e.name);return json(res,503,{error:'temporarily_unavailable',reason:'client_lookup_storage_unavailable'})}
  const scope=String(a.scope||'brave:read').trim().split(/\s+/).filter(Boolean);
  if(scope.some(x=>!['brave:read','brave:control','brave:book'].includes(x)))return json(res,400,{error:'invalid_scope'});
  const legacyPending=client?null:legacyChatGPTClient(a.client_id,a.redirect_uri);
  const acceptedClient=client||legacyPending;
  if(!acceptedClient){console.warn('OAuth authorization: stale or invalid client registration');return json(res,400,{error:'invalid_request',reason:'client_registration_invalid_or_expired',next_step:'Register a new ChatGPT app connection'})}
  if(!acceptedClient.redirects.includes(a.redirect_uri)||a.response_type!=='code'||a.code_challenge_method!=='S256'||!/^[-_a-zA-Z0-9]{43,128}$/.test(a.code_challenge||'')){console.warn('OAuth authorization: invalid redirect or PKCE request');return json(res,400,{error:'invalid_request',reason:'redirect_or_pkce_invalid'})}
  if(req.method==='GET'){
   res.setHeader('Content-Type','text/html; charset=utf-8');
   const fields=['client_id','redirect_uri','response_type','code_challenge','code_challenge_method','state','scope'].map(k=>'<input type="hidden" name="'+k+'" value="'+String(a[k]||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')+'">').join('');
   return res.status(200).send('<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Brave Booking Authorization</title></head><body style="font:16px system-ui;max-width:460px;margin:8vh auto;padding:20px"><h2>Authorize Brave Booking Assistant</h2><p>Grant only the requested scopes: read to inspect approved pages, control to navigate and interact after local 10-minute authorization, and book for reservation operations. Booking confirmation requires separate approval in the Brave extension.</p><form method="post" enctype="application/x-www-form-urlencoded">'+fields+'<label>Enter your private MCP bridge token <input name="owner_token" type="password" required autocomplete="off" style="display:block;width:100%;padding:10px;margin:12px 0"></label><button type="submit">Authorize</button></form></body></html>');
  }
  if(typeof a.owner_token!=='string'||!a.owner_token){
   console.warn('OAuth form missing owner_token; bodyType='+typeof req.body+'; contentType='+String(req.headers['content-type']||'unknown').split(';')[0]);
   return json(res,400,{error:'invalid_request',reason:'missing_owner_token'});
  }
  const got=Buffer.from(a.owner_token,'utf8'),expected=Buffer.from(secret(),'utf8');
  if(got.length!==expected.length||!crypto.timingSafeEqual(got,expected)){
   console.warn('OAuth authorization rejected: credential mismatch');
   return json(res,403,{error:'access_denied'});
  }
  if(legacyPending){
   try{
    const d=await clientStore();
    await d.query("INSERT INTO oauth_clients(id_hash,redirect_uris,expires_at) VALUES($1,$2::jsonb,now()+interval '30 days') ON CONFLICT (id_hash) DO NOTHING",[clientHash(a.client_id),JSON.stringify([a.redirect_uri])]);
    console.info('OAuth legacy ChatGPT client registered after owner authorization');
   }catch(e){console.error('OAuth legacy migration storage',e.code||e.name);return json(res,503,{error:'temporarily_unavailable',reason:'legacy_client_storage_unavailable'})}
  }
  const code=sign({kind:'code',client:a.client_id,redirect:a.redirect_uri,challenge:a.code_challenge,scope:scope.join(' '),exp:Date.now()+120000,nonce:crypto.randomUUID()});
  try{const d=await codeStore();await d.query('INSERT INTO oauth_codes(code_hash,expires_at) VALUES ($1,now()+interval \'2 minutes\')',[crypto.createHash('sha256').update(code).digest('hex')]);}catch(e){console.error('oauth code storage',e.code||e.name);return json(res,503,{error:'temporarily_unavailable',reason:e.code==='28P01'?'staging_database_credentials_invalid':e.code==='28000'?'staging_database_endpoint_unavailable':'staging_database_unavailable'});}
  const u=new URL(a.redirect_uri);u.searchParams.set('code',code);if(a.state)u.searchParams.set('state',a.state);return res.redirect(302,u.toString());
 }
 if(path.endsWith('/token')){
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const a=parsedBody(req),code=valid(a.code,'code');
  let client;
  try{client=await lookupClient(a.client_id)}catch(e){console.error('oauth client token lookup',e.code||e.name);return json(res,503,{error:'temporarily_unavailable',reason:'client_lookup_storage_unavailable'})}
  if(a.grant_type!=='authorization_code'||!code||!client||!client.redirects.includes(a.redirect_uri)||code.client!==a.client_id||code.redirect!==a.redirect_uri)return json(res,400,{error:'invalid_grant'});
  const digest=crypto.createHash('sha256').update(String(a.code_verifier||'')).digest('base64url');
  if(digest!==code.challenge)return json(res,400,{error:'invalid_grant'});
  try{const d=await codeStore();const consumed=await d.query('DELETE FROM oauth_codes WHERE code_hash=$1 AND expires_at>now() RETURNING code_hash',[crypto.createHash('sha256').update(a.code).digest('hex')]);if(!consumed.rowCount)return json(res,400,{error:'invalid_grant'});}catch(e){console.error('oauth code consume',e.code||e.name);return json(res,503,{error:'temporarily_unavailable',reason:e.code==='28P01'?'staging_database_credentials_invalid':e.code==='28000'?'staging_database_endpoint_unavailable':'staging_database_unavailable'});}
  const granted=code.scope||'brave:read';
  const token=sign({kind:'access',scope:granted,exp:Date.now()+3600000});
  return json(res,200,{access_token:token,token_type:'Bearer',expires_in:3600,scope:granted});
 }
 return json(res,404,{error:'not_found'});
}
