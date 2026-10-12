// Authorized logins expire quietly and stop a long run hours later. Each hour the watcher opens every site listed
// in RUN/login-sites.json in a new background tab of Jay's logged-in Chrome (chrome-relay), reads where it landed,
// and closes only that tab (Jay 2026-10-11 approved the background Chrome use and the hourly check).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const LOGIN_CHECK_MS=60*60*1000;
const relay=()=>process.env.CHROME_RELAY_BIN||path.join(os.homedir(),'.npm-global/bin/chrome-relay');
const call=(args,timeout=30000)=>execFileSync(relay(),args,{encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']}).trim();
function sites(run){
  try{const value=JSON.parse(fs.readFileSync(path.join(run,'login-sites.json'),'utf8'));
    return (value.sites||[]).filter(site=>site&&site.name&&/^https?:\/\//.test(site.url)&&site.loggedOutPattern);}catch{return [];}
}
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
// Returns sites that just became logged out; each logout is reported once until the site is logged in again.
function due(state,run,now=Date.now()){
  if(!sites(run).length||now-(state.lastLoginCheckAt||0)<LOGIN_CHECK_MS)return null;
  state.lastLoginCheckAt=now;
  const results=sites(run).map(checkSite),seen=state.loginOut||={};
  fs.writeFileSync(path.join(run,'login-status.json'),JSON.stringify({checkedAt:new Date(now).toISOString(),results},null,2)+'\n');
  const fresh=[];
  for(const item of results){
    if(item.status==='logged_out'&&!seen[item.name]){seen[item.name]=new Date(now).toISOString();fresh.push(item);}
    else if(item.status==='logged_in')delete seen[item.name];
  }
  return fresh;
}
module.exports={LOGIN_CHECK_MS,sites,checkSite,due};
