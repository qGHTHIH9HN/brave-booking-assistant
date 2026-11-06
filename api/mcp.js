import crypto from 'node:crypto';
import pg from 'pg';
import {validateBrowserCommand,READ_ACTIONS,BROWSER_ACTIONS} from './browser-command-utils.js';
import {valid as validOAuth} from './oauth.js';
const safeCommands=new Set(['open_listing','inspect_active']);
const bookingCommands=new Set(['start_booking','resume_booking','inspect_booking']);
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
 prepare_booking:['brave:book'],
 book_now:['brave:book']
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
 tool('send_booking_command','Prepare or inspect a booking. For an explicit instruction to Complete booking on the current freshly inspected final review, use confirm_booking: it submits through the same one-shot book_now checks with exact displayed total and cancellation cap, without another extension click. Never use it on a confirmed stay or before reviewing the final page.',{action:{type:'string',enum:['start_booking','resume_booking','inspect_booking','confirm_booking']},url:{type:'string',description:'Booking.com Morocco listing URL'},checkin:{type:'string',description:'YYYY-MM-DD'},checkout:{type:'string',description:'YYYY-MM-DD'},adults:{type:'integer',minimum:1,maximum:8},roomType:{type:'string',description:'Preferred room type e.g. Tent'},maxTotal:{type:'number',exclusiveMinimum:0},currency:{type:'string',enum:['EUR','MAD','USD','GBP','AUD']},vpnCountry:{type:'string',pattern:'^(?:[A-Z]{2}|AUTO)$',description:'Optional Proton VPN country: AUTO lets Brave choose an eligible country, while FR/DE/US etc. select that country automatically through the merged extension Proton connection manager. Country is verified before booking.'},vpnCity:{type:'string',maxLength:120,description:'Optional exact city from the real Proton VPN server catalog; requires vpnCountry'},vpnLogicalId:{type:'string',maxLength:120,description:'Optional exact logical server ID from Proton catalog'},vpnServerId:{type:'string',maxLength:120,description:'Optional exact physical server ID from Proton catalog'},guestIndex:{type:'integer',minimum:1,maximum:1000,description:'1-based guest position saved locally in Brave; do not send guest names or emails'}},['action']),
 tool('prepare_booking','Start a single guided Booking.com reservation workflow: open the property, select requested stay and room, use locally saved authorized guest details, and STOP for final review. If guest details are absent, pause at the guest form. No financial submission is authorized by this tool.',{url:{type:'string',description:'Booking.com Morocco hotel listing URL'},checkin:{type:'string',description:'YYYY-MM-DD'},checkout:{type:'string',description:'YYYY-MM-DD'},adults:{type:'integer',minimum:1,maximum:8},roomType:{type:'string',description:'Requested room type e.g. Tent or empty string for any'},maxTotal:{type:'number',exclusiveMinimum:0},currency:{type:'string',enum:['EUR','MAD','USD','GBP','AUD']},vpnCountry:{type:'string',pattern:'^(?:[A-Z]{2}|AUTO)$',description:'Optional Proton VPN country: AUTO lets Brave choose an eligible country, while FR/DE/US etc. select that country automatically through the merged extension Proton connection manager. Country is verified before booking.'},vpnCity:{type:'string',maxLength:120,description:'Optional exact city from the real Proton VPN server catalog; requires vpnCountry'},vpnLogicalId:{type:'string',maxLength:120,description:'Optional exact logical server ID from Proton catalog'},vpnServerId:{type:'string',maxLength:120,description:'Optional exact physical server ID from Proton catalog'},guestIndex:{type:'integer',minimum:1,maximum:1000,description:'Optional 1-based guest index saved locally in Brave; no PII uploaded'}},['url','checkin','checkout','adults','roomType','maxTotal','currency']),
 tool('book_now','ONE explicit booking instruction authorizes final submission of ONE real Booking.com reservation without any additional extension approval checkbox or click. Can reuse the current matching final Booking.com review or start a new booking. USE ONLY if the user explicitly orders final submission in the current message and provides an exact stay, room, total-price ceiling and currency, plus maximum cancellation charge and its currency. May create a binding reservation and cancellation charges. Automatically STOP on missing identity, currency mismatches, unverifiable or changed fees, card requirements, or pricing above the authorized ceilings. Do not call for prepare/inspect or on generic approval of a previous command.',{url:{type:'string',description:'Approved Booking.com Morocco hotel listing URL'},checkin:{type:'string',description:'YYYY-MM-DD'},checkout:{type:'string',description:'YYYY-MM-DD'},adults:{type:'integer',minimum:1,maximum:8},roomType:{type:'string',description:'Exact requested room type, e.g. Tent'},maxTotal:{type:'number',exclusiveMinimum:0,description:'Absolute final reservation price cap'},currency:{type:'string',enum:['EUR','MAD','USD','GBP','AUD']},maxCancellationCharge:{type:'number',minimum:0,maximum:100000,description:'Maximum accepted cancellation fee; use zero for free cancellation only'},cancellationCurrency:{type:'string',enum:['EUR','MAD','USD','GBP','AUD']},vpnCountry:{type:'string',pattern:'^(?:[A-Z]{2}|AUTO)$',description:'Optional Proton VPN country: AUTO lets Brave choose an eligible country, while FR/DE/US etc. select that country automatically through the merged extension Proton connection manager. Country is verified before booking.'},vpnCity:{type:'string',maxLength:120,description:'Optional exact city from the real Proton VPN server catalog; requires vpnCountry'},vpnLogicalId:{type:'string',maxLength:120,description:'Optional exact logical server ID from Proton catalog'},vpnServerId:{type:'string',maxLength:120,description:'Optional exact physical server ID from Proton catalog'},guestIndex:{type:'integer',minimum:1,maximum:1000,description:'Optional 1-based authorized guest stored locally in Brave; do not send personal data'},confirmSubmission:{type:'boolean',enum:[true],description:'True only when the user explicitly requested final booking submission in this turn'}},['url','checkin','checkout','adults','roomType','maxTotal','currency','maxCancellationCharge','cancellationCurrency','confirmSubmission']),
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
 // prepare_booking remains read/review-only; book_now is a separate one-shot authorization.
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
  if(name==='send_booking_command'||name==='prepare_booking'||name==='book_now'){
   if(name==='book_now'&&rawArgs.confirmSubmission!==true)return send(res,200,err(m.id,-32602,'Book now requires an explicit user instruction to submit this reservation'));
   if(name==='book_now'&&Object.keys(rawArgs).some(k=>!['url','checkin','checkout','adults','roomType','maxTotal','currency','guestIndex','vpnCountry','vpnCity','vpnLogicalId','vpnServerId','maxCancellationCharge','cancellationCurrency','confirmSubmission'].includes(k)))return send(res,200,err(m.id,-32602,'Unexpected booking field; only exact approved terms allowed'));
   if(name==='book_now'&&(!Number.isFinite(rawArgs.maxCancellationCharge)||rawArgs.maxCancellationCharge<0||rawArgs.maxCancellationCharge>100000||!['EUR','MAD','USD','GBP','AUD'].includes(rawArgs.cancellationCurrency)))return send(res,200,err(m.id,-32602,'A cancellation charge ceiling and currency are required'));
   if(name==='book_now'&&typeof rawArgs.roomType==='string'&&!rawArgs.roomType.trim())return send(res,200,err(m.id,-32602,'Book now requires an exact room preference'));
   if(name==='book_now')args.action='start_booking';
   if(name==='prepare_booking'&&Object.keys(rawArgs).some(k=>!['url','checkin','checkout','adults','roomType','maxTotal','currency','guestIndex','vpnCountry','vpnCity','vpnLogicalId','vpnServerId'].includes(k)))return send(res,200,err(m.id,-32602,'Only approved stay fields and local guest index allowed'));
   if(!ownerAllowed&&!String(client?.scope||'').split(' ').includes('brave:book'))return scopeChallenge(req,res,m.id,'brave:book');
   // Backward-compatibility bridge: older ChatGPT connections expose confirm_booking
   // but do not expose the new book_now tool. A deliberate confirm_booking call
   // is authorized ONLY against a fresh, inspected Booking.com final review.
   // The extension still performs all one-shot price/date/room/VPN/guest checks.
   if(name==='send_booking_command'&&args.action==='confirm_booking'){
    const inspectionRow=(await db().query("SELECT id,result,finished_at FROM extension_commands WHERE action='inspect_active' AND status='completed' ORDER BY id DESC LIMIT 1")).rows[0];
    const view=inspectionRow?.result||{};
    if(!inspectionRow||!inspectionRow.finished_at||Date.now()-new Date(inspectionRow.finished_at).getTime()>5*60*1000||
       view.phase!=='review'||view.pageUrl!=='https://secure.booking.com/book.html'||
       view.blocked!==false||view.payAtProperty!==true||view.requiresCreditCard!==false||
       !/^(?:complete booking|book with commitment to pay|confirm (?:your )?booking)$/i.test(String(view.finalButton||'').trim())||
       view.finalTargetEvidence?.disabled!==false)
     return send(res,200,err(m.id,-32602,'Final Booking.com review is missing, too old, already confirmed, or not safe to submit; inspect the active review first'));
    const preparedRow=(await db().query("SELECT id,payload,created_at FROM extension_commands WHERE action='start_booking' AND id<$1 AND created_at>now()-interval '4 hours' ORDER BY id DESC LIMIT 1",[inspectionRow.id])).rows[0];
    const previous=preparedRow?.payload||{};
    if(!preparedRow||!validateUrl(previous.url)||!previous.checkin||!previous.checkout||
       !Number.isInteger(previous.adults)||previous.adults<1||previous.adults>8||
       typeof previous.roomType!=='string'||!previous.roomType.trim()||
       previous.checkin!==view.checkin||previous.checkout!==view.checkout||
       previous.checkin!==view.datesEvidence?.checkin||previous.checkout!==view.datesEvidence?.checkout)
      return send(res,200,err(m.id,-32602,'Prepared stay does not match the current Booking.com checkout; do not submit'));
    for(const field of ['url','checkin','checkout','adults','roomType','guestIndex'])
      if(args[field]!==undefined&&args[field]!==previous[field])
       return send(res,200,err(m.id,-32602,'Requested '+field+' differs from the reviewed stay'));
    const amountPattern='([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)';
    const totalMatch=new RegExp('^Total\\s+(EUR|MAD|USD|GBP|AUD)\\s+'+amountPattern+'\\s*$','i').exec(String(view.totalHint||'').trim());
    if(!totalMatch)return send(res,200,err(m.id,-32602,'Exact displayed price and currency must be verified before submission'));
    const totalCurrency=totalMatch[1].toUpperCase(),total=Number(totalMatch[2].replace(/,/g,''));
    if(!Number.isFinite(total)||total<=0||total>100000)return send(res,200,err(m.id,-32602,'Invalid current total'));
    if(args.maxTotal!==undefined&&args.currency===totalCurrency&&total>args.maxTotal)
     return send(res,200,err(m.id,-32602,'Displayed total exceeds user-provided price cap'));
    if(previous.currency===totalCurrency&&Number.isFinite(previous.maxTotal)&&total>previous.maxTotal)
     return send(res,200,err(m.id,-32602,'Displayed total exceeds prepared price cap'));
    const policies=Array.isArray(view.policies)?view.policies.map(String):[];
    const feeRegex=new RegExp('if you cancel[^.]*?pay\\s+(EUR|MAD|USD|GBP|AUD)\\s+'+amountPattern,'i');
    let feeMatch=null;
    for(const policy of policies){const found=feeRegex.exec(policy);if(found){feeMatch=found;break}}
    const cancellation=feeMatch?Number(feeMatch[2].replace(/,/g,'')):
      policies.some(p=>/free cancellation/i.test(p))?0:null;
    const cancelCurrency=feeMatch?feeMatch[1].toUpperCase():totalCurrency;
    if(cancellation===null||!Number.isFinite(cancellation)||cancellation<0||cancellation>100000)
     return send(res,200,err(m.id,-32602,'Cancellation charge must be explicitly visible and verified'));
    const newer=(await db().query("SELECT id FROM extension_commands WHERE action='book_now' AND id>$1 LIMIT 1",[inspectionRow.id])).rows[0];
    if(newer)return send(res,200,err(m.id,-32602,'Another Book now command has already been queued; inspect its outcome before retrying'));
    const payload={url:previous.url,checkin:previous.checkin,checkout:previous.checkout,
      adults:previous.adults,roomType:previous.roomType,maxTotal:total,currency:totalCurrency,
      maxCancellationCharge:cancellation,cancellationCurrency:cancelCurrency,
      authorization:'submit_this_booking',authorizedAt:Date.now()};
    for(const field of ['guestIndex','vpnCountry','vpnCity','vpnLogicalId','vpnServerId'])
      if(previous[field]!==undefined)payload[field]=previous[field];
    const queued=await db().query("INSERT INTO extension_commands (action,payload) VALUES ('book_now',$1::jsonb) RETURNING id,action,status,created_at",[JSON.stringify(payload)]);
    return send(res,200,ok(m.id,{content:[{type:'text',text:JSON.stringify(queued.rows[0])}]}));
   }
   if(!bookingCommands.has(args.action))return send(res,200,err(m.id,-32602,'Unsupported booking action'));
   let payload={};
   if(args.action==='start_booking'){
    if(!validateUrl(args.url))return send(res,200,err(m.id,-32602,'Only approved Morocco hotel listing URLs allowed'));
    const date=/^\d{4}-\d{2}-\d{2}$/,a=new Date(String(args.checkin)+'T00:00:00Z'),b=new Date(String(args.checkout)+'T00:00:00Z');
    if(!date.test(args.checkin)||!date.test(args.checkout)||!Number.isFinite(+a)||!Number.isFinite(+b)||b<=a||b-a>30*86400000)return send(res,200,err(m.id,-32602,'Invalid stay dates'));
    if(!Number.isInteger(args.adults)||args.adults<1||args.adults>8||typeof args.roomType!=='string'||args.roomType.length>80)return send(res,200,err(m.id,-32602,'Invalid adults or room type'));
    if(typeof args.maxTotal!=='number'||!Number.isFinite(args.maxTotal)||args.maxTotal<=0||args.maxTotal>100000||!['EUR','MAD','USD','GBP','AUD'].includes(args.currency))return send(res,200,err(m.id,-32602,'Maximum total and currency required'));
    if(args.guestIndex!==undefined&&(!Number.isInteger(args.guestIndex)||args.guestIndex<1||args.guestIndex>1000))return send(res,200,err(m.id,-32602,'Invalid local guest index'));
    if(args.vpnCountry!==undefined&&(typeof args.vpnCountry!=='string'||!/^(?:[A-Z]{2}|AUTO)$/.test(args.vpnCountry)))return send(res,200,err(m.id,-32602,'VPN must be AUTO or a two-letter country code (FR, DE, US, etc.)'));
    for(const key of ['vpnCity','vpnLogicalId','vpnServerId']){
      if(args[key]!==undefined&&(typeof args[key]!=='string'||args[key].length>120))return send(res,200,err(m.id,-32602,'Invalid requested Proton '+key));
      if(args[key]!==undefined&&!args.vpnCountry)return send(res,200,err(m.id,-32602,'Choose vpnCountry when selecting a Proton city or server'));
    }
    if(name!=='book_now'&&Object.keys(args).some(k=>!['action','url','checkin','checkout','adults','roomType','maxTotal','currency','guestIndex','vpnCountry','vpnCity','vpnLogicalId','vpnServerId'].includes(k)))return send(res,200,err(m.id,-32602,'Guest information must stay local in Brave'));
    payload={url:args.url,checkin:args.checkin,checkout:args.checkout,adults:args.adults,roomType:args.roomType,maxTotal:args.maxTotal,currency:args.currency};
    if(args.guestIndex!==undefined)payload.guestIndex=args.guestIndex;
    if(args.vpnCountry!==undefined)payload.vpnCountry=args.vpnCountry;
    for(const key of ['vpnCity','vpnLogicalId','vpnServerId'])if(args[key]!==undefined)payload[key]=args[key];
    if(name==='book_now'){
      payload.authorization='submit_this_booking';
      payload.authorizedAt=Date.now();
      payload.maxCancellationCharge=args.maxCancellationCharge;
      payload.cancellationCurrency=args.cancellationCurrency;
    }
   }else if(Object.keys(args).some(k=>k!=='action'))return send(res,200,err(m.id,-32602,'No extra fields permitted'));
   const queuedAction=name==='book_now'?'book_now':args.action;
   const r=await db().query('INSERT INTO extension_commands (action,payload) VALUES ($1,$2::jsonb) RETURNING id,action,status,created_at',[queuedAction,JSON.stringify(payload)]);
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