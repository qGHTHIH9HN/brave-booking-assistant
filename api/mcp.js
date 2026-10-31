import crypto from 'node:crypto';
import pg from 'pg';
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
const tool=(name,description,properties,required=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const tools=[
 tool('send_safe_command','Queue a read-only browser command; never books or pays.',{action:{type:'string',enum:['open_listing','inspect_active']},url:{type:'string',description:'Required only for open_listing; Booking.com Morocco hotel listing URL.'}},['action']),
 tool('send_booking_command','Queue a Booking.com reservation step in the user\'s Brave browser. start_booking navigates to guest details and final review. confirm_booking submits only after matching approval made locally in Brave.',{action:{type:'string',enum:['start_booking','resume_booking','inspect_booking','confirm_booking']},url:{type:'string',description:'Approved Booking.com Morocco hotel listing URL for start_booking'},checkin:{type:'string',description:'YYYY-MM-DD for start_booking'},checkout:{type:'string',description:'YYYY-MM-DD for start_booking'},adults:{type:'integer',minimum:1,maximum:8},roomType:{type:'string',description:'Preferred exact room type; use Tent for this case'},maxTotal:{type:'number',exclusiveMinimum:0},currency:{type:'string',enum:['EUR','MAD','USD','GBP']}},['action']),
 tool('get_command_status','Read status and result of an existing command.',{id:{type:'integer',minimum:1}},['id'])
];
function validateUrl(value){
 if(typeof value!=='string')return false;
 try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.booking.com'&&/^\/hotel\/ma\/[a-z0-9-]+\.en-gb\.html$/.test(u.pathname)&&!u.username&&!u.password;}catch{return false}
}
export default async function handler(req,res){
 if(process.env.VERCEL_ENV==='production')return send(res,404,{error:'Not available in production'});
 if(!auth(req)&&!validOAuth((req.headers.authorization||'').replace(/^Bearer /i,''),'access')){res.setHeader('WWW-Authenticate','Bearer realm="Brave Booking Assistant"');return send(res,401,{error:'Unauthorized',message:'A valid scoped access token is required'});}
 if(req.method==='GET')return send(res,200,{name:'Brave Booking Assistant MCP Preview',version:'0.2.0',readOnly:false});
 if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
 let m;try{m=req.body;if(typeof m==='string')m=JSON.parse(m)}catch{return send(res,400,{error:'Invalid JSON'})}
 if(!m||m.jsonrpc!=='2.0'||typeof m.method!=='string')return send(res,400,{error:'Invalid JSON-RPC'});
 if(m.method==='notifications/initialized')return res.status(202).end();
 if(m.method==='initialize')return send(res,200,ok(m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'brave-booking-assistant-preview',version:'0.2.0'}}));
 if(m.method==='ping')return send(res,200,ok(m.id,{}));
 if(m.method==='tools/list')return send(res,200,ok(m.id,{tools}));
 if(m.method!=='tools/call')return send(res,200,err(m.id,-32601,'Method not found'));
 const name=m.params?.name,args=m.params?.arguments||{};
 try{
  if(name==='send_safe_command'){
   if(!safeCommands.has(args.action))return send(res,200,err(m.id,-32602,'Unsupported read-only action'));
   if(args.action==='open_listing'&&!validateUrl(args.url))return send(res,200,err(m.id,-32602,'Only Booking.com Morocco hotel listings allowed'));
   const payload=args.action==='open_listing'?{url:args.url}:{};
   const r=await db().query('INSERT INTO extension_commands (action,payload) VALUES ($1,$2::jsonb) RETURNING id,action,status,created_at',[args.action,JSON.stringify(payload)]);
   return send(res,200,ok(m.id,{content:[{type:'text',text:JSON.stringify(r.rows[0])}]}));
  }
  if(name==='send_booking_command'){
   if(!bookingCommands.has(args.action))return send(res,200,err(m.id,-32602,'Unsupported booking action'));
   let payload={};
   if(args.action==='start_booking'){
    if(!validateUrl(args.url))return send(res,200,err(m.id,-32602,'Only approved Morocco hotel listing URLs allowed'));
    const date=/^\d{4}-\d{2}-\d{2}$/,a=new Date(String(args.checkin)+'T00:00:00Z'),b=new Date(String(args.checkout)+'T00:00:00Z');
    if(!date.test(args.checkin)||!date.test(args.checkout)||!Number.isFinite(+a)||!Number.isFinite(+b)||b<=a||b-a>30*86400000)return send(res,200,err(m.id,-32602,'Invalid stay dates'));
    if(!Number.isInteger(args.adults)||args.adults<1||args.adults>8||typeof args.roomType!=='string'||args.roomType.length>80)return send(res,200,err(m.id,-32602,'Invalid adults or room type'));
    if(typeof args.maxTotal!=='number'||!Number.isFinite(args.maxTotal)||args.maxTotal<=0||args.maxTotal>100000||!['EUR','MAD','USD','GBP'].includes(args.currency))return send(res,200,err(m.id,-32602,'Maximum total and currency required'));
    payload={url:args.url,checkin:args.checkin,checkout:args.checkout,adults:args.adults,roomType:args.roomType,maxTotal:args.maxTotal,currency:args.currency};
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