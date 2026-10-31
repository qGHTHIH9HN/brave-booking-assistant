import crypto from 'node:crypto';
import pg from 'pg';
let pool;
const database=()=>pool||(pool=new pg.Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:8000}));
async function codeStore(){const d=database();await d.query('CREATE TABLE IF NOT EXISTS oauth_codes (code_hash text PRIMARY KEY, expires_at timestamptz NOT NULL)');return d;}
const origin=req=>`https://${req.headers.host}`;
const secret=()=>process.env.MCP_BRIDGE_TOKEN||'';
const h=(s)=>crypto.createHmac('sha256',secret()).update(s).digest('base64url');
const b=(x)=>Buffer.from(JSON.stringify(x)).toString('base64url');
const unb=(s)=>JSON.parse(Buffer.from(s,'base64url').toString());
export const valid=(s,kind)=>{if(!secret()||!s)return null;const parts=s.split('.');if(parts.length!==2)return null;const expected=h(parts[0]);if(parts[1].length!==expected.length||!crypto.timingSafeEqual(Buffer.from(parts[1]),Buffer.from(expected)))return null;try{const p=unb(parts[0]);return p.kind===kind&&p.exp>Date.now()?p:null}catch{return null}};
export const sign=(p)=>{const s=b(p);return s+'.'+h(s)};
const json=(res,status,data)=>res.status(status).json(data);
const isAllowedRedirect=(u)=>{try{const x=new URL(u);return x.protocol==='https:'&&!x.username&&!x.password&&x.hash===''||x.protocol==='http:'&&['localhost','127.0.0.1'].includes(x.hostname)}catch{return false}};
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(process.env.VERCEL_ENV==='production')return json(res,404,{error:'not_found'});
 if(!secret())return json(res,503,{error:'oauth_not_configured'});
 const route=req.query?.route||'';
 const path=route==='metadata'? '/.well-known/oauth-authorization-server':route==='resource'? '/.well-known/oauth-protected-resource': '/api/oauth/'+route;
 const base=origin(req);
 if(path.endsWith('/.well-known/oauth-protected-resource'))return json(res,200,{resource:base+'/api/mcp',authorization_servers:[base]});
 if(path.endsWith('/.well-known/oauth-authorization-server'))return json(res,200,{issuer:base,authorization_endpoint:base+'/api/oauth/authorize',token_endpoint:base+'/api/oauth/token',registration_endpoint:base+'/api/oauth/register',response_types_supported:['code'],grant_types_supported:['authorization_code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['brave:read']});
 if(path.endsWith('/register')){
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const a=req.body||{};if(!Array.isArray(a.redirect_uris)||a.redirect_uris.length<1||a.redirect_uris.length>5||!a.redirect_uris.every(isAllowedRedirect))return json(res,400,{error:'invalid_redirect_uri'});
  const id=sign({kind:'client',redirects:a.redirect_uris,exp:Date.now()+30*86400000});
  return json(res,201,{client_id:id,client_name:a.client_name||'ChatGPT MCP',redirect_uris:a.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']});
 }
 if(path.endsWith('/authorize')){
  const a=req.method==='POST'?req.body:req.query;
  const client=valid(a.client_id,'client');
  if(!client||!client.redirects.includes(a.redirect_uri)||a.response_type!=='code'||a.code_challenge_method!=='S256'||!/^[-_a-zA-Z0-9]{43,128}$/.test(a.code_challenge||''))return json(res,400,{error:'invalid_request'});
  if(req.method==='GET'){
   res.setHeader('Content-Type','text/html; charset=utf-8');
   const fields=['client_id','redirect_uri','response_type','code_challenge','code_challenge_method','state'].map(k=>'<input type="hidden" name="'+k+'" value="'+String(a[k]||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')+'">').join('');
   return res.status(200).send('<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Brave Booking Authorization</title></head><body style="font:16px system-ui;max-width:460px;margin:8vh auto;padding:20px"><h2>Authorize Brave Booking Assistant</h2><p>Read-only browser commands. No booking or payment.</p><form method="post">'+fields+'<label>Enter your private MCP bridge token <input name="owner_token" type="password" required autocomplete="off" style="display:block;width:100%;padding:10px;margin:12px 0"></label><button type="submit">Authorize</button></form></body></html>');
  }
  const got=String(a.owner_token||''),expected=secret();
  if(got.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(got),Buffer.from(expected)))return json(res,403,{error:'access_denied'});
  const code=sign({kind:'code',client:a.client_id,redirect:a.redirect_uri,challenge:a.code_challenge,exp:Date.now()+120000,nonce:crypto.randomUUID()});
  try{const d=await codeStore();await d.query('INSERT INTO oauth_codes(code_hash,expires_at) VALUES ($1,now()+interval \'2 minutes\')',[crypto.createHash('sha256').update(code).digest('hex')]);}catch(e){console.error('oauth code storage',e.code||e.name);return json(res,503,{error:'temporarily_unavailable'});}
  const u=new URL(a.redirect_uri);u.searchParams.set('code',code);if(a.state)u.searchParams.set('state',a.state);return res.redirect(302,u.toString());
 }
 if(path.endsWith('/token')){
  if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});
  const a=req.body||{},code=valid(a.code,'code'),client=valid(a.client_id,'client');
  if(a.grant_type!=='authorization_code'||!code||!client||code.client!==a.client_id||code.redirect!==a.redirect_uri)return json(res,400,{error:'invalid_grant'});
  const digest=crypto.createHash('sha256').update(String(a.code_verifier||'')).digest('base64url');
  if(digest!==code.challenge)return json(res,400,{error:'invalid_grant'});
  try{const d=await codeStore();const consumed=await d.query('DELETE FROM oauth_codes WHERE code_hash=$1 AND expires_at>now() RETURNING code_hash',[crypto.createHash('sha256').update(a.code).digest('hex')]);if(!consumed.rowCount)return json(res,400,{error:'invalid_grant'});}catch(e){console.error('oauth code consume',e.code||e.name);return json(res,503,{error:'temporarily_unavailable'});}
  const token=sign({kind:'access',scope:'brave:read',exp:Date.now()+3600000});
  return json(res,200,{access_token:token,token_type:'Bearer',expires_in:3600,scope:'brave:read'});
 }
 return json(res,404,{error:'not_found'});
}
