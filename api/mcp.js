import crypto from 'node:crypto';
import pg from 'pg';
import {validateBrowserCommand,READ_ACTIONS,BROWSER_ACTIONS} from './browser-command-utils.js';
import {valid as validOAuth} from './oauth.js';
const safeCommands=new Set(['open_listing','inspect_active']);
const bookingCommands=new Set(['start_booking','resume_booking','inspect_booking','confirm_booking']);
let pool;
function db(){
 const url=process.env.STAGING_DATABASE_URL;
 if(!url)throw new Error('staging_database_unconfigured');
 if(!pool)pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:8000});
 return pool;
}
function auth(req){
 const supplied=(req.headers.authorization||'').replace(/^Bearer /i,'');
 const expected=process.env.MCP_BRIDGE_TOKEN||'';
 return !!expected&&supplied.length===expected.length&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));
}
const send=(res,status,body)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');return res.status(status).json(body)};
const err=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const ok=(id,result)=>({jsonrpc:'2.0',id,result});
// OAuth scopes are advertised per tool so ChatGPT can request additional consent.
const toolScopes={
 send_safe_command:['brave:read'],
 get_command_status:['brave:read'],
 send_browser_command:['brave:control'],
 send_booking_command:['brave:book'],
 prepare_booking:['brave:book']
};
const tool=(name,description,properties,required=[])=>({
 name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},
 securitySchemes:[{type:'oauth2',scopes:toolScopes[name]||['brave:read']}]
});
const scopeChallenge=(req,res,id,scope)=>{
 const challenge='Bearer resource_metadata="https://'+req.headers.host+'/.well-known/oauth-protected-resource", scope="'+scope+'", error="insufficient_scope", error_description="Authorize Brave Booking Assistant for '+scope+'"';
 res.setHeader('WWW-Authenticate',challenge);
 return send(res,200,ok(id,{isError:true,content:[{type:'text',text:'Additional OAuth consent required for '+scope+'. Please reauthorize this app with the requested scope.'}],_meta:{'mcp/www_authenticate':[challenge]}}));
};
const tools=[
 tool('send_safe_command','Queue a read-only browser command; never books or pays.',{action:{type:'string',enum:['open_listing','inspect_active']},url:{type:'string',description:'Required only for open_listing; Booking.com Morocco hotel listing URL.'}},['action']),
 tool('send_booking_command','Queue Booking.com booking steps in Brave. start_booking stops at final review; confirm_booking requires separate prior local approval.',{action:{type:'string',enum:['start_booking','resume_booking','inspect_booking','confirm_booking']},url:{type:'string',description:'Booking.com Morocco listing URL'},checkin:{type:'string',description:'YYYY-MM-DD'},checkout:{type:'string',description:'YYYY-MM-DD'},adults:{type:'integer',minimum:1,maximum:8},roomType:{type:'string',description:'Preferred room type e.g. Tent'},maxTotal:{type:'number',exclusiveMinimum:0},currency:{type:'string',enum:['EUR','MAD','USD','GBP']},guestIndex:{type:'integer',minimum:1,maximum:1000,description:'1-based guest position saved locally in Brave; do not send guest names or emails'}},['action']),
 tool('prepare_booking','Start a single guided Booking.com reservation workflow: open the property, select requested stay and room, use locally saved authorized guest details, and STOP for final review. If guest details are absent, pause at the guest form. No financial submission is authorized by this tool.',{url:{type:'string',description:'Booking.com Morocco hotel listing URL'},checkin:{type:'string',description:'YYYY-MM-DD'},checkout:{type:'string',description:'YYYY-MM-DD'},adults:{type:'integer',minimum:1,maximum:8},roomType:{type:'string',description:'Requested room type e.g. Tent or empty string for any'},maxTotal:{type:'number',exclusiveMinimum:0},currency:{type:'string',enum:['EUR','MAD','USD','GBP']},guestIndex:{type:'integer',minimum:1,maximum:1000,description:'Optional 1-based guest index saved locally in Brave; no PII uploaded'}},['url','checkin','checkout','adults','roomType','maxTotal','currency']),
 tool('send_browser_command','Control approved Brave browser sites only. Read actions require brave:read; navigation, scrolling, clicking, and text search require brave:control and a temporary approval in the local extension. Never sends payments or bookings.',{action:{type:'string',enum:[...BROWSER_ACTIONS]},url:{type:'string',description:'HTTPS URL for browser_open_url; host must be locally approved in Brave'},selector:{type:'string',description:'CSS selector for click or type_text'},text:{type:'string',description:'Short nonsensitive text, only for browser_type_text'},direction:{type:'string',enum:['up','down']},pixels:{type:'integer',minimum:1,maximum:1200}},['action']),
 tool('get_command_status','Read status and result of an existing command.',{id:{type:'integer',minimum:1}},['id'])
];
function validateUrl(value){
 if(typeof value!=='string')return false;
 try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.booking.com'&&/^\/hotel\/ma\/[a-z0-9-]+\.en-gb\.html$/.test(u.pathname)&&!u.username&&!u.password;}catch{return false}
}
export default async function handler(req,res){
 if(process.env.VERCEL_ENV==='production')return send(res,404,{error:'Not available in production'});
 const bearer=(req.headers.authorization||'').replace(/^Bearer /i,'');
 const ownerAllowed=auth(req),client=validOAuth(bearer,'access');
 if(!ownerAllowed&&!client){
  res.setHeader('WWW-Authenticate','Bearer realm="Brave Booking Assistant", resource_metadata="https://'+req.headers.host+'/.well-known/oauth-protected-resource", scope="brave:read", error="invalid_token", error_description="Authorize Brave Booking Assistant"');
  return send(res,401,{error:'Unauthorized',message:'A valid scoped access token is required'});
 }
 if(req.method==='GET')return send(res,200,{name:'Brave Booking Assistant MCP Preview',version:'0.2.0',readOnly:false});
 if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
 let m;try{m=req.body;if(typeof m==='string')m=JSON.parse(m)}catch{return send(res,400,{error:'Invalid JSON'})}
 if(!m||m.jsonrpc!=='2.0'||typeof m.method!=='string')return send(res,400,{error:'Invalid JSON-RPC'});
 if(m.method==='notifications/initialized')return res.status(202).end();
 if(m.method==='initialize')return send(res,200,ok(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'brave-booking-assistant-preview',version:'0.2.0'}}));
 if(m.method==='ping')return send(res,200,ok(m.id,{}));
 if(m.method==='tools/list')return send(res,200,ok(m.id,{tools}));
 if(m.method!=='tools/call')return send(res,200,err(m.id,-32601,'Method not found'));
 const name=m.params?.name,rawArgs=m.params?.arguments||{};
 // prepare_booking is always a preparation action, never final submission.
 const args=name==='prepare_booking'?{...rawArgs,action:'start_booking'}:rawArgs;
 try{
  if(name==='send_safe_command'){
   if(!safeCommands.has(args.action))return send(res,200,err(m.id,-32602,'Unsupported read-only action'));
   if(args.action==='open_listing'&&!validateUrl(args.url))return send(res,200,err(m.id,-32602,'Only Booking.com Morocco hotel listings allowed'));
   const payload=args.action==='open_listing'?{url:args.url}:{};
   const r=await db().query('INSERT INTO extension_commands (action,payload) VALUES ($1,$2::jsonb) RETURNING id,action,status,created_at',[args.action,JSON.stringify(payload)]);
   return send(res,200,ok(m.id,{content:[{type:'text',text:JSON.stringify(r.rows[0])}]}));
  }
  if(name==='send_browser_command'){
   const scope=String(client?.scope||'').split(' ');
   const isRead=READ_ACTIONS.has(args.action);
   if(!ownerAllowed&&!scope.includes(isRead?'brave:read':'brave:control')&&!(isRead&&scope.includes('brave:control')))return scopeChallenge(req,res,m.id,isRead?'brave:read':'brave:control');
   let c;try{c=validateBrowserCommand(args)}catch(e){return send(res,200,err(m.id,-32602,e.message));}
   const r=await db().query('INSERT INTO extension_commands (action,payload) VALUES ($1,$2::jsonb) RETURNING id,action,status,created_at',[c.action,JSON.stringify(c.payload)]);
   return send(res,200,ok(m.id,{content:[{type:'text',text:JSON.stringify(r.rows[0])}]}));
  }
  if(name==='send_booking_command'||name==='prepare_booking'){
   if(name==='prepare_booking'&&Object.keys(rawArgs).some(k=>!['url','checkin','checkout','adults','roomType','maxTotal','currency','guestIndex'].includes(k)))return send(res,200,err(m.id,-32602,'Only approved stay fields and local guest index allowed'));
   if(!ownerAllowed&&!String(client?.scope||'').split(' ').includes('brave:book'))return scopeChallenge(req,res,m.id,'brave:book');
   if(!bookingCommands.has(args.action))return send(res,200,err(m.id,-32602,'Unsupported booking action'));
   let payload={};
   if(args.action==='start_booking'){
    if(!validateUrl(args.url))return send(res,200,err(m.id,-32602,'Only approved Morocco hotel listing URLs allowed'));
    const date=/^\d{4}-\d{2}-\d{2}$/,a=new Date(String(args.checkin)+'T00:00:00Z'),b=new Date(String(args.checkout)+'T00:00:00Z');
    if(!date.test(args.checkin)||!date.test(args.checkout)||!Number.isFinite(+a)||!Number.isFinite(+b)||b<=a||b-a>30*86400000)return send(res,200,err(m.id,-32602,'Invalid stay dates'));
    if(!Number.isInteger(args.adults)||args.adults<1||args.adults>8||typeof args.roomType!=='string'||args.roomType.length>80)return send(res,200,err(m.id,-32602,'Invalid adults or room type'));
    if(typeof args.maxTotal!=='number'||!Number.isFinite(args.maxTotal)||args.maxTotal<=0||args.maxTotal>100000||!['EUR','MAD','USD','GBP'].includes(args.currency))return send(res,200,err(m.id,-32602,'Maximum total and currency required'));
    if(args.guestIndex!==undefined&&(!Number.isInteger(args.guestIndex)||args.guestIndex<1||args.guestIndex>1000))return send(res,200,err(m.id,-32602,'Invalid local guest index'));
    if(Object.keys(args).some(k=>!['action','url','checkin','checkout','adults','roomType','maxTotal','currency','guestIndex'].includes(k)))return send(res,200,err(m.id,-32602,'Guest information must stay local in Brave'));
    payload={url:args.url,checkin:args.checkin,checkout:args.checkout,adults:args.adults,roomType:args.roomType,maxTotal:args.maxTotal,currency:args.currency};
    if(args.guestIndex!==undefined)payload.guestIndex=args.guestIndex;
   }else if(Object.keys(args).some(k=>k!=='action'))return send(res,200,err(m.id,-32602,'No extra fields permitted'));
   const r=await db().query('INSERT INTO extension_commands (action,payload) VALUES ($1,$2::jsonb) RETURNING id,action,status,created_at',[args.action,JSON.stringify(payload)]);
   return send(res,200,ok(m.id,{content:[{type:'text',text:JSON.stringify(r.rows[0])}]}));
  }
  if(name==='get_command_status'){
   if(!Number.isSafeInteger(args.id)||args.id<1)return send(res,200,err(m.id,-32602,'Invalid command id'));
   const r=await db().query('SELECT id,action,status,result,created_at,finished_at FROM extension_commands WHERE id=$1',[args.id]);
   return send(res,200,ok(m.id,{content:[{type:'text',text:JSON.stringify(r.rows[0]||null)}]}));
  }
  return send(res,200,err(m.id,-32602,'Unknown tool'));
 }catch(e){console.error('MCP bridge failure',e.code||e.name);return send(res,200,err(m.id,-32603,'Command service unavailable'))}
}