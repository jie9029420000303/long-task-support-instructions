// Authorized logins expire quietly and stop a long run hours later. login-sites.json lists every login the task needs.
// A website (url + loggedOutPattern) opens in a new background tab of Jay's logged-in Chrome (chrome-relay); the check
// reads where it landed and closes only that tab (Jay 2026-10-11 approved the background Chrome use and the hourly
// check). Anything else (a CLI/API token, an MCP sign-in, ssh, a test identity) names a read-only shell command (Jay
// 2026-10-14; on 2026-10-13 the uat2/uat3 Claude CLI profiles could not be registered as sites and were found expired
// mid-run). Only the result is kept, never a command's output, so no secret reaches the run folder.
// `node login-check.cjs DIR` checks every login at once: the start-time preflight on the preparation directory, before
// the supervisor asks Jay anything, and again on RUN whenever the list changes.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const LOGIN_CHECK_MS=60*60*1000,COMMAND_TIMEOUT_MS=60000;
const relay=()=>process.env.CHROME_RELAY_BIN||path.join(os.homedir(),'.npm-global/bin/chrome-relay');
const call=(args,timeout=30000)=>execFileSync(relay(),args,{encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']}).trim();
const need=(ok,message)=>{if(!ok)throw Error(message);};
const text=value=>typeof value==='string'&&value.trim();
const usable=site=>site&&text(site.name)&&(text(site.check)||/^https?:\/\//.test(site.url)&&text(site.loggedOutPattern));
const compiles=site=>{try{return Boolean(text(site.check)||new RegExp(site.loggedOutPattern,'i'));}catch{return false;}};
// The watcher checks what it can; validate() is the strict form for the preflight and init.
function sites(run){
  try{const value=JSON.parse(fs.readFileSync(path.join(run,'login-sites.json'),'utf8'));return (value.sites||[]).filter(usable);}catch{return [];}
}
function validate(list){
  need(Array.isArray(list),'login sites must be a list: {"sites":[…]}, or {"sites":[]} when the task uses no login');
  const problems=[],names=new Set();
  list.forEach((site,index)=>{
    if(!usable(site)||!compiles(site))problems.push('#'+(index+1)+(text(site?.name)?' '+site.name:'')+' needs a name and either check (a read-only command) or url plus a valid loggedOutPattern');
    else if(names.has(site.name))problems.push(site.name+' is listed twice');
    else names.add(site.name);
  });
  need(!problems.length,'Invalid login list: '+problems.join('; '));
  return list;
}
const write=(dir,list)=>fs.writeFileSync(path.join(dir,'login-sites.json'),JSON.stringify({sites:validate(list)},null,2)+'\n');
function checkSite(site){
  let tab=null;
  try{
    const opened=call(['navigate',site.url,'--new']);
    tab=/(?:tab(?:Id)?\D{0,4})(\d+)/i.exec(opened)?.[1]||/\b(\d{3,})\b/.exec(opened)?.[1];
    if(!tab)return {name:site.name,url:site.url,status:'error',detail:'無法取得新分頁編號：'+opened.slice(0,120)};
    try{call(['wait','--load','networkidle','--tab',tab],30000);}catch{}
    const url=call(['get','url','--tab',tab]),title=call(['get','title','--tab',tab]);
    const out=new RegExp(site.loggedOutPattern,'i').test(url+'\n'+title);
    return {name:site.name,url:site.url,status:out?'logged_out':'logged_in',landedUrl:url,title};
  }catch(error){return {name:site.name,url:site.url,status:'error',detail:String(error.message).slice(0,200)};}
  finally{if(tab)try{call(['close',tab]);}catch{}}
}
// Exit 0 = the login works, 1 = it has lapsed. Any other exit (126/127: no such command; a crash; a mistyped server
// name trapped by the check) or a timeout means the check itself is broken: that is never reported as a logout, so
// nobody is asked to log in again when the check needs fixing. A check exits 1 only when it knows the credential was
// refused: ssh exits 255 for a refused key and for an unreachable host alike (2026-10-15 GDB: a firewall timeout was
// reported as a logout), so an ssh check tests its output for "Permission denied". A fixed working directory keeps a project's own
// settings (for example its MCP list) from changing the answer between the preflight and the watcher.
function checkCommand(site){
  try{execFileSync('/bin/sh',['-c',site.check],{cwd:os.tmpdir(),timeout:COMMAND_TIMEOUT_MS,stdio:'ignore'});return {name:site.name,status:'logged_in'};}
  catch(error){
    if(error.status===1)return {name:site.name,status:'logged_out',detail:'檢查指令結束碼 1（已失效）'};
    return {name:site.name,status:'error',detail:error.code==='ETIMEDOUT'?'檢查指令超過 '+COMMAND_TIMEOUT_MS/1000+' 秒':
      Number.isInteger(error.status)?'檢查指令結束碼 '+error.status+'（檢查本身出錯，不是登入失效）':'檢查指令無法執行：'+(error.code||error.signal)};
  }
}
function checkAll(run,list=sites(run),now=Date.now()){
  const results=list.map(site=>({...(text(site.check)?checkCommand(site):checkSite(site)),...(site.login?{login:site.login}:{})}));
  fs.writeFileSync(path.join(run,'login-status.json'),JSON.stringify({checkedAt:new Date(now).toISOString(),results},null,2)+'\n');
  return results;
}
// Returns logins that just stopped working: logged out, or the check itself broke. Each name is reported once per
// state, again when that state changes (a broken check, then a real logout), and again after it worked in between.
function due(state,run,now=Date.now()){
  const list=sites(run);
  if(!list.length||now-(state.lastLoginCheckAt||0)<LOGIN_CHECK_MS)return null;
  state.lastLoginCheckAt=now;
  const seen=state.loginOut||={},fresh=[];
  for(const item of checkAll(run,list,now)){
    if(item.status==='logged_in')delete seen[item.name];
    else if(seen[item.name]!==item.status){seen[item.name]=item.status;fresh.push(item);}
  }
  return fresh;
}
module.exports={LOGIN_CHECK_MS,COMMAND_TIMEOUT_MS,sites,validate,write,checkSite,checkCommand,checkAll,due};
if(require.main===module){
  try{
    const dir=process.argv[2]&&path.resolve(process.argv[2]);
    need(dir&&fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory(),'usage: node login-check.cjs DIR (the preparation directory before init, or RUN; it holds login-sites.json)');
    const file=path.join(dir,'login-sites.json');
    need(fs.existsSync(file),file+' is missing: list every login the task uses ({"sites":[]} when it uses none)');
    let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){throw Error(file+' is not JSON: '+error.message);}
    const results=checkAll(dir,validate(value?.sites));
    console.log(JSON.stringify({checkedAt:new Date().toISOString(),checked:results.length,needsAction:results.filter(item=>item.status!=='logged_in'),results},null,2));
  }catch(error){console.error(error.message);process.exitCode=2;}
}
