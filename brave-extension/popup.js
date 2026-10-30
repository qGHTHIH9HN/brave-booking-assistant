const $=id=>document.getElementById(id);
const BASE='http://127.0.0.1:8765';
async function api(path, body){const r=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'Shared service error');return d}
async function save(){await chrome.storage.local.set({gmail:$('gmail').value.trim(),names:$('names').value,nameMode:$('nameMode').value,phone:$('phone').value.trim()});$('status').textContent='Settings saved in this Chrome profile.'}
async function fill(){try{await save();const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)throw Error('Open a booking page first.');
 const detected=await chrome.scripting.executeScript({target:{tabId:tab.id},func:detectCountry});
 const profile=await api('/allocate',{gmail:$('gmail').value.trim(),names:$('names').value,nameMode:$('nameMode').value,country:detected[0]?.result||'',phone:$('phone').value.trim()});
 const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:fillForm,args:[profile]});
 $('status').textContent=`${profile.full}\n${profile.email}\n${profile.phone||'(phone unchanged)'}\n${result[0]?.result||'Finished.'}\nReserved in shared database.`;
 }catch(e){$('status').textContent='Error: '+e.message}}
$('save').addEventListener('click',save);$('fill').addEventListener('click',fill);$('again').addEventListener('click',fill);
$('reset').addEventListener('click',async()=>{if(!confirm('Erase ALL shared used-name, email and phone history across Chrome profiles?'))return;try{await api('/reset',{confirm:'ERASE_TEST_HISTORY'});$('status').textContent='Shared test history cleared.'}catch(e){$('status').textContent=e.message}});
chrome.storage.local.get(['gmail','names','nameMode','phone']).then(v=>{for(const key of ['gmail','names','nameMode','phone'])if(v[key])$(key).value=v[key]});
fetch(BASE+'/health').then(r=>r.json()).then(d=>$('connection').textContent=d.ok?'Connected':'Disconnected').catch(()=>$('connection').textContent='Offline — start server');
function detectCountry(){
 const tel=document.querySelector('input[type="tel"]');
 const near=tel?.closest('form')||document;
 const nodes=[...near.querySelectorAll('select,option,[role="combobox"],button,input')];
 const candidates=nodes.filter(e=>e.matches('select,[role="combobox"]')||e.getAttribute('aria-label')?.match(/country|dial|code/i)||e.name?.match(/country|dial|code/i));
 return candidates.map(e=>[e.value,e.getAttribute('aria-label'),e.selectedOptions?.[0]?.textContent,e.textContent?.slice(0,70)].filter(Boolean).join(' ')).join(' ').slice(0,1500);
}
function fillForm(profile){
 const inputs=[...document.querySelectorAll('input:not([type=hidden]):not([disabled])')];
 function description(el){let labels=[el.getAttribute('aria-label'),el.placeholder,el.name,el.id,el.autocomplete];if(el.labels)labels.push(...[...el.labels].map(x=>x.textContent));return labels.filter(Boolean).join(' ').toLowerCase()}
 function match(re){return inputs.find(el=>re.test(description(el)))}
 function put(el,value){if(!el)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;setter.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return true}
 const parts=profile.full.trim().split(/\s+/);const given=parts.shift();const family=parts.join(' ');let n=0;
 n+=put(match(/first.?name|given.?name|given-name|firstname/),given)?1:0;
 n+=put(match(/last.?name|family.?name|surname|lastname|family-name/),family)?1:0;
 n+=put(match(/email|e-mail/),profile.email)?1:0;
 const tel=inputs.find(el=>el.type==='tel')||match(/phone.?number|mobile.?number|telephone/);
 if(tel&&profile.phone){put(tel,profile.phone);n++;}
 return `Filled ${n} field(s). ${profile.phone?'Reserved test phone inserted.':'Phone left unchanged.'}`;
}
