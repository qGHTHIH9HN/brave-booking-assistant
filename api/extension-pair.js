import crypto from 'node:crypto';
import {sign} from './oauth.js';

// Preview-only pairing: exchange the password that already works for ChatGPT
// for a limited browser-polling session. Never persist or echo that password.
const respond=(res,status,data)=>{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 return res.status(status).json(data);
};
function requestBody(req){
 if(req.body&&typeof req.body==='object'&&!Array.isArray(req.body))return req.body;
 if(typeof req.body==='string'&&req.body.length<=4096){
  try{return JSON.parse(req.body)}catch{return {}}
 }
 return {};
}
export default function handler(req,res){
 if(process.env.VERCEL_ENV==='production')return respond(res,404,{error:'not_found'});
 if(req.method!=='POST'){res.setHeader('Allow','POST');return respond(res,405,{error:'method_not_allowed'})}
 const secret=process.env.MCP_BRIDGE_TOKEN||'';
 if(!secret)return respond(res,503,{error:'pairing_not_configured'});
 const supplied=requestBody(req).owner_token;
 if(typeof supplied!=='string'||!supplied||supplied.length>4096)return respond(res,400,{error:'missing_authorization_password'});
 const a=Buffer.from(supplied,'utf8'),b=Buffer.from(secret,'utf8');
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return respond(res,401,{error:'authorization_password_mismatch'});
 const exp=Date.now()+30*86400000;
 const sessionToken=sign({kind:'extension',scope:'command:poll',exp,nonce:crypto.randomUUID()});
 return respond(res,200,{session_token:sessionToken,expires_at:new Date(exp).toISOString(),scope:'command:poll'});
}
