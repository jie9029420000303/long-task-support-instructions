#!/usr/bin/env node
// Push a short notice to Jay's phone through his Telegram bot 「Jay的小秘書」 (Jay 2026-10-29: a stalled watch and a
// batch of questions waiting on him both reach him there, not only inside a chat he may not have open).
// Model-free: the watcher, its parent and the system guard call it. A claim file per notice key makes each push
// happen at most once even when two processes notice the same thing. The bot token stays in the macOS keychain and
// the recipient in the user-level config (LONG_TASK_HOME/notify.json), never in a run or this repository. Messages
// carry no buttons: another local program reads this bot's button replies, and two readers would race for them.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const home=()=>process.env.LONG_TASK_HOME||path.join(os.homedir(),'.config','long-task-supervisor');
const configFile=()=>process.env.LONG_TASK_NOTIFY_CONFIG||path.join(home(),'notify.json');
const retryMs=()=>Number(process.env.LONG_TASK_NOTIFY_RETRY_MS)||5000;
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const hide=text=>String(text||'').replace(/bot\d+:[\w-]+/g,'bot<token>');
function settings(){const telegram=readJson(configFile())?.telegram;return telegram?.chatId&&telegram.keychainService?telegram:null;}
function token(telegram){
  if(process.env.LONG_TASK_TELEGRAM_TOKEN)return process.env.LONG_TASK_TELEGRAM_TOKEN; // tests only
  return execFileSync('security',['find-generic-password','-s',telegram.keychainService,'-a',telegram.keychainAccount||'','-w'],
    {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:10000}).trim();
}
// One try and one retry (Jay 2026-10-29); the caller records a failure where Jay will see it.
async function post(text){
  const telegram=settings();
  if(process.env.LONG_TASK_NOTIFY_DISABLE==='1'||!telegram)return {ok:false,attempts:0,error:'not_configured: '+configFile()};
  const base=process.env.LONG_TASK_TELEGRAM_API||'https://api.telegram.org';
  let error;
  for(let attempt=1;attempt<=2;attempt++){
    if(attempt>1)await new Promise(resolve=>setTimeout(resolve,retryMs()));
    try{
      const response=await fetch(base+'/bot'+token(telegram)+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({chat_id:telegram.chatId,text,disable_web_page_preview:true}),signal:AbortSignal.timeout(20000)});
      const body=await response.json().catch(()=>({}));
      if(response.ok&&body.ok)return {ok:true,attempts:attempt};
      error='HTTP '+response.status+(body.description?' '+body.description:'');
    }catch(caught){error=hide(caught.message||caught);}
  }
  return {ok:false,attempts:2,error:hide(error)};
}
const claimFile=(dir,key)=>path.join(dir,'notifications',String(key).replace(/[^\w.-]+/g,'_').slice(0,120)+'.json');
function sent(dir,key){return readJson(claimFile(dir,key));}
// Test runs live under the system temp directory: they never reach Jay's phone unless a test names its own config.
const real=file=>{try{return fs.realpathSync(file);}catch{return path.resolve(file);}};
const temporary=dir=>{const tmp=real(os.tmpdir()),at=real(dir);return at===tmp||at.startsWith(tmp+path.sep);};
// The first caller to create the claim file sends; any later caller with the same key gets the saved outcome.
async function sendOnce(dir,key,text){
  const file=claimFile(dir,key);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  let fd;
  try{fd=fs.openSync(file,'wx');}
  catch(error){if(error.code==='EEXIST')return {skipped:true,...(sent(dir,key)||{key})};throw error;}
  fs.writeSync(fd,JSON.stringify({key,text,claimedAt:new Date().toISOString()})+'\n');fs.closeSync(fd);
  const outcome=temporary(dir)&&!process.env.LONG_TASK_NOTIFY_CONFIG?{ok:false,attempts:0,error:'test run under the temp directory'}:await post(text);
  const record={key,text,at:new Date().toISOString(),...outcome};
  fs.writeFileSync(file+'.tmp',JSON.stringify(record,null,2)+'\n');fs.renameSync(file+'.tmp',file);
  return record;
}
// Copy the recipient from an existing bot config without printing it; the token stays in the keychain.
function configure(service,account,source){
  const chatId=readJson(source)?.chatId;
  if(!service||!chatId)throw Error('Usage: notify.cjs configure KEYCHAIN_SERVICE KEYCHAIN_ACCOUNT SOURCE_JSON_WITH_chatId');
  fs.mkdirSync(path.dirname(configFile()),{recursive:true});
  fs.writeFileSync(configFile(),JSON.stringify({telegram:{keychainService:service,keychainAccount:account||'',chatId,configuredFrom:source,
    configuredAt:new Date().toISOString()}},null,2)+'\n',{mode:0o600});
  return {configured:true,file:configFile()};
}
module.exports={post,sendOnce,sent,settings,configFile,home};
if(require.main===module){
  const [command,...args]=process.argv.slice(2);
  (async()=>{
    const result=command==='configure'?configure(...args)
      :command==='status'?{configured:Boolean(settings()),file:configFile()}
      :command==='test'?await post(args.join(' ')||'【測試】長任務監督推播測試，不用處理。')
      :(()=>{throw Error('Commands: status, test [TEXT], configure KEYCHAIN_SERVICE KEYCHAIN_ACCOUNT SOURCE_JSON');})();
    console.log(JSON.stringify(result));
    if(result.ok===false)process.exitCode=1;
  })().catch(error=>{console.error(hide(error.message));process.exitCode=1;});
}
