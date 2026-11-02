// Validate browser-only actions before putting them into the shared command queue.
// Brave itself enforces its locally approved host allowlist and temporary control window.
export const BROWSER_ACTIONS=Object.freeze([
 'browser_list_tabs','browser_inspect_tab','browser_open_url','browser_scroll','browser_click','browser_type_text'
]);
const actions=new Set(BROWSER_ACTIONS);
export const READ_ACTIONS=new Set(['browser_list_tabs','browser_inspect_tab']);
export function validateBrowserCommand(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid browser action');
 const action=input.action;
 if(!actions.has(action))throw new Error('Unsupported browser action');
 const allowedFields={
  browser_list_tabs:[],browser_inspect_tab:[],
  browser_open_url:['url'],browser_scroll:['direction','pixels'],
  browser_click:['selector'],browser_type_text:['selector','text']
 }[action];
 if(Object.keys(input).some(k=>k!=='action'&&!allowedFields.includes(k)))throw new Error('Unexpected browser action field');
 const payload={};
 if(action==='browser_open_url'){
  if(typeof input.url!=='string'||input.url.length>1000)throw new Error('Invalid navigation URL');
  let u;try{u=new URL(input.url)}catch{throw new Error('Invalid navigation URL');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)throw new Error('Only standard HTTPS URLs without embedded credentials are supported');
  if(!/^[a-z0-9.-]+$/i.test(u.hostname)||u.hostname==='localhost'||!u.hostname.includes('.')||u.hostname.endsWith('.local'))throw new Error('Invalid public HTTPS host');
  payload.url=u.href;
 }
 if(action==='browser_scroll'){
  if(!['up','down'].includes(input.direction)||!Number.isInteger(input.pixels)||input.pixels<1||input.pixels>1200)throw new Error('Invalid scrolling distance');
  payload.direction=input.direction;payload.pixels=input.pixels;
 }
 if(action==='browser_click'||action==='browser_type_text'){
  if(typeof input.selector!=='string'||!input.selector.trim()||input.selector.length>160||/[\r\n]/.test(input.selector))throw new Error('Invalid CSS selector');
  payload.selector=input.selector;
 }
 if(action==='browser_type_text'){
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>150||/[\r\n]/.test(input.text))throw new Error('Only short single-line search terms are permitted');
  payload.text=input.text;
 }
 return {action,payload};
}
