// Keep commands and refusal output in the original transcript; reviews carry stable hashes and locators only.
const fs=require('node:fs'),crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const normalize=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,300);
const commandKey=value=>'sha256:'+digest(normalize(value));
function sourceOf(item,binding){const src=item?.source||{};return {path:src.path||binding?.executorLog||null,...(Number.isInteger(src.offset)?{offset:src.offset}:{}),...(src.messageId?{messageId:src.messageId}:{}),...(src.callId||item?.callId?{callId:src.callId||item.callId}:{}),...(src.outputSha256?{outputSha256:src.outputSha256}:{})};}
function rejection(item,binding){return {callId:item.callId,at:item.at,item:'工具操作',source:sourceOf(item,binding),...(item.reason?{reasonSha256:digest(item.reason)}:item.reasonSha256?{reasonSha256:item.reasonSha256}:{})};}
function platformError(item,binding){if(!item)return item;const {text,...rest}=item;return {...rest,...(text?{text:'平台回報錯誤，請查原始紀錄',textSha256:item.textSha256||digest(text)}:{}),source:sourceOf(item,binding)};}
function event(value,binding){if(!value)return value;const out={...value};let changed=false;
 if(out.permission?.newRejections){out.permission={...out.permission,newRejections:out.permission.newRejections.map(item=>rejection(item,binding))};changed=true;}
 if(Array.isArray(out.executorBlocked)&&out.executorBlocked.some(item=>item.command!==undefined)){out.executorBlocked=out.executorBlocked.map(item=>({id:item.id,since:item.since,summary:'指令操作尚未開始',source:sourceOf(item,binding)}));changed=true;}
 if(Array.isArray(out.failedCommands)&&out.failedCommands.some(item=>item.command!==undefined)){out.failedCommands=out.failedCommands.map(item=>({commandHash:item.commandHash||commandKey(item.command),count:item.count,lastAt:item.lastAt,source:sourceOf(item,binding)}));changed=true;}
 if(out.platformError?.text){out.platformError=platformError(out.platformError,binding);changed=true;}
 if(out.rateLimitReset?.text){out.rateLimitReset=platformError(out.rateLimitReset,binding);changed=true;}
 // The digest preserves change detection even when a legacy event's raw fields are not displayed.
 if(changed)out.originalEventSha256=digest(JSON.stringify(value)+'\n');return out;
}
function commandAt(source,binding){if(!source?.callId||source.path!==binding.executorLog)return null;
 try{let lines;if(Number.isInteger(source.offset)){const fd=fs.openSync(source.path,'r');let pos=source.offset,parts=[];try{for(;;){const buf=Buffer.alloc(65536),n=fs.readSync(fd,buf,0,buf.length,pos);if(!n)break;const end=buf.subarray(0,n).indexOf(10);parts.push(buf.subarray(0,end<0?n:end));if(end>=0)break;pos+=n;}}finally{fs.closeSync(fd);}lines=[Buffer.concat(parts).toString('utf8')];}else lines=fs.readFileSync(source.path,'utf8').split('\n');
 for(const text of lines){let row;try{row=JSON.parse(text);}catch{continue;}for(const block of row.message?.content||[])if(block?.type==='tool_use'&&block.id===source.callId&&typeof block.input?.command==='string')return normalize(block.input.command);}
 }catch{}return null;
}
function migrate(state,binding){
 for(const [id,entry] of Object.entries(state.openTools||{})){if(typeof entry==='string'||entry?.command!==undefined){const old=typeof entry==='string'?{command:entry}:entry;state.openTools[id]={commandHash:commandKey(old.command),source:{path:binding.executorLog,callId:id},at:old.at,background:old.background,poll:old.poll};}}
 for(const [id,value] of Object.entries(state.callItems||{}))if(typeof value==='string'&&!/^sha256:[a-f0-9]{64}$/.test(value))state.callItems[id]='sha256:'+digest(value);
 const failed={};for(const [key,value] of Object.entries(state.failedCommands||{})){const safe=/^sha256:[a-f0-9]{64}$/.test(key)?key:commandKey(key),previous=failed[safe];
   failed[safe]={count:Math.max(previous?.count||0,value.count||0),lastAt:previous?.lastAt>value.lastAt?previous.lastAt:value.lastAt,...(value.announced?{announced:value.announced}:{}),...(value.source?{source:sourceOf(value,binding)}:{})};}state.failedCommands=failed;
 state.reviewRejections=(state.reviewRejections||[]).map(item=>({...rejection(item,binding),itemKey:item.itemKey||'sha256:'+digest(item.item||item.callId)}));
 for(const key of ['platformError','rateLimit'])if(state[key]?.text)state[key]=platformError(state[key],binding);
 for(const key of Object.keys(state.clockAnnounced||{}))if(key.startsWith('rejected-item:')&&!/^rejected-item:sha256:[a-f0-9]{64}$/.test(key)){state.clockAnnounced['rejected-item:sha256:'+digest(key.slice('rejected-item:'.length))]=state.clockAnnounced[key];delete state.clockAnnounced[key];}
}
module.exports={digest,normalize,commandKey,rejection,platformError,event,commandAt,migrate};
