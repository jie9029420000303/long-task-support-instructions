// Read completion facts without a model. Notifications and periodic checks use the same durable receipt keys.
// This module never sends a message, declares PASS, runs a supplied command, or changes a resource.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function contained(root,file){const rel=path.relative(root,file);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));}
function real(file){
  let current=path.resolve(file),suffix=[];
  while(!fs.existsSync(current)){const parent=path.dirname(current);if(parent===current)throw Error('No existing parent');suffix.unshift(path.basename(current));current=parent;}
  return path.join(fs.realpathSync(current),...suffix);
}
function allowed(binding,file){
  if(typeof file!=='string'||!path.isAbsolute(file))return false;
  try{return (binding.allowedRoots||[]).some(root=>contained(real(root),real(file)));}catch{return false;}
}
function inspect(binding,wait,snapshot,agents=[],receipts={}){
  if(snapshot?.executorId&&snapshot.executorId!==binding.executorId)return {sources:[],ready:[],issues:['Completion snapshot belongs to another executor'],observable:false,files:[],blocked:true};
  const sources=[],issues=[],seen=new Set(),live=snapshot?.packages||{};
  function resource(file,id,packageId,since){
    if(!allowed(binding,file)){issues.push('Resource ledger outside allowed roots');return;}
    try{
      const rows=JSON.parse(fs.readFileSync(file,'utf8')).resources;
      if(!Array.isArray(rows))throw Error('Invalid resource ledger');
      for(const row of rows){
        if(row.kind!=='process'||(id?row.id!==id:row.wp!==packageId))continue;
        const stopped=Date.parse(row.stopped_at),started=Date.parse(row.start||row.created_at);
        if(since&&Number.isFinite(stopped)&&stopped<since&&(!Number.isFinite(started)||started<since))continue;
        const identity=digest(['resource',real(file),row.id,row.start||row.created_at]);
        if(seen.has(identity))continue;seen.add(identity);
        sources.push({kind:'resource',path:file,id:row.id,packageId:packageId||row.wp||null,key:identity,identity,
          ready:Number.isFinite(stopped),finishedAt:Number.isFinite(stopped)?row.stopped_at:null});
      }
    }catch{issues.push('Resource completion not readable');}
  }
  function result(item,packageId=null){
    if(item?.ledger&&typeof item.id==='string'){resource(item.ledger,item.id,packageId,null);return;}
    if(!item||!allowed(binding,item.path)||(item.sha256!==null&&!/^[a-f0-9]{64}$/.test(item.sha256||''))){issues.push('Invalid result completion source');return;}
    try{
      const current=fs.existsSync(item.path)?crypto.createHash('sha256').update(fs.readFileSync(item.path)).digest('hex'):null;
      // Removal of an existing result is an unknown state, not completion.
      sources.push({kind:'result',path:item.path,packageId,key:digest(['result',real(item.path),current]),
        identity:digest(['result',real(item.path)]),ready:current!==null&&current!==item.sha256});
    }catch{issues.push('Result completion not readable');}
  }
  const explicit=wait?.event?.waitFor;
  if(explicit!==undefined&&!Array.isArray(explicit))issues.push('Invalid completion source list');
  for(const item of Array.isArray(explicit)?explicit:[])result(item);
  for(const item of [...(live.inFlight||[]),...(live.returned||[])]){
    const since=Date.parse(item.baseline?.startedAt)||null,ledgerRefs=[];
    function refs(value){
      if(!value||typeof value!=='object')return;
      if(typeof value.ledger==='string'&&typeof value.id==='string')ledgerRefs.push(value);
      for(const [key,child] of Object.entries(value)){
        if(typeof child==='string'&&/ResourceLedger$/.test(key))ledgerRefs.push({ledger:child});
        else if(child&&typeof child==='object'&&!['evidence','baselineHistory','candidateHistory'].includes(key))refs(child);
      }
    }
    refs(item);
    const resourceId=/^resource:(.+)$/.exec(item.handle||'')?.[1];
    for(const file of item.evidence||[]){
      if(typeof file!=='string'||!path.isAbsolute(file))continue;
      if(path.basename(file)==='resources.json')ledgerRefs.push({ledger:file,id:resourceId});
      else if(path.basename(path.dirname(file))==='resources')ledgerRefs.push({ledger:path.join(path.dirname(path.dirname(file)),'resources.json'),id:resourceId});
    }
    if(snapshot?.workPackageDirectory)ledgerRefs.push({ledger:path.join(path.dirname(snapshot.workPackageDirectory),'resources.json'),id:resourceId});
    for(const ref of ledgerRefs)if(fs.existsSync(ref.ledger))resource(ref.ledger,ref.id,item.id,since);
    const handle=(item.handle||'').replace(/^agent:/,'').replace(/^workflow:/,'');
    const matches=agents.filter(agent=>[agent.id,agent.path,agent.workflow&&agent.label?agent.workflow+':'+agent.label:null].filter(Boolean).includes(handle));
    const agent=matches.sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))[0];
    if(agent){
      const key=digest(['agent',agent.id,agent.completedTurnId||agent.completionId||agent.completedAt||agent.lastAt]),identity=digest(['agent',agent.id,agent.startedAt]);
      if(!seen.has(identity)){seen.add(identity);sources.push({kind:'agent',id:agent.id,packageId:item.id,key,identity,
        path:agent.sourceFile||null,ready:Boolean(agent.done||agent.finished),finishedAt:(agent.done||agent.finished)&&(agent.completedAt||agent.lastAt)?new Date(agent.completedAt||agent.lastAt).toISOString():null});}
    }
  }
  const ready=sources.filter(item=>item.ready&&!receipts[item.key]);
  return {sources,ready,issues,observable:sources.length>0,files:[...new Set(sources.map(item=>item.path).filter(Boolean))]};
}
// Atomic ledger replacement may lose a file watch; watch its directory and keep the caller's periodic timeout.
async function waitChange(ms,readInspection,extraFiles=[]){
  return new Promise(resolve=>{
    const watchers=new Map();let ended=false;
    function done(reason){if(ended)return;ended=true;clearTimeout(timer);for(const watcher of watchers.values())watcher.close();resolve(reason);}
    function refresh(){
      if(ended)return;
      let inspection;try{inspection=readInspection();}catch{return;}
      if(inspection.ready.length){done('completion');return;}
      const files=[...inspection.files,...extraFiles];
      for(const file of files){
        const dir=path.dirname(file);if(watchers.has(dir)||!fs.existsSync(dir))continue;
        try{
          const watcher=fs.watch(dir,(_event,name)=>{
            if(!name||files.some(value=>path.dirname(value)===dir&&path.basename(value)===String(name)))refresh();
          });watcher.on('error',()=>{watcher.close();watchers.delete(dir);});watchers.set(dir,watcher);
        }catch{}
      }
    }
    const timer=setTimeout(()=>done('periodic'),Math.max(1,ms));refresh();
  });
}
function prompt(event,inspection){
  const facts=inspection.ready.map(item=>({kind:item.kind,packageId:item.packageId,id:item.id||null,path:item.path||null,finishedAt:item.finishedAt||null}));
  return `執行層續接 ${event.id}：${facts.length?'背景程式已偵測到工作結果，請核對原始結果後續做。':event.kind==='progress'?'依你已列明的下一步繼續執行。':'原等待檢查時間已到，請核對現況並補齊可觀察的完成來源。'}\n`+
    (facts.length?'完成來源：'+JSON.stringify(facts)+'\n':'')+
    `下一步：${event.nextAction}。沿用原契約、授權與有效證據；完成通知不代表成功或驗收通過。一般結果與可自行處理的失敗由執行主線收回、查核、修正並續派；需裁決、未授權動作、獨立驗收或無法自行恢復的阻塞才交監督。`;
}
// What the supervisor needs to judge a declared wait, read by code: which completion sources still run, which finished
// (and whether that result already went to the executor), and what could not be read. Locations only, never contents.
function facts(inspection){
  const fresh=new Set((inspection.ready||[]).map(source=>source.key)),sources=inspection.sources||[];
  const item=source=>({kind:source.kind,packageId:source.packageId||null,id:source.id||null,path:source.path||null,
    ...(source.finishedAt?{finishedAt:source.finishedAt}:{}),...(source.ready&&!fresh.has(source.key)?{delivered:true}:{})});
  return {observable:Boolean(inspection.observable),running:sources.filter(source=>!source.ready).map(item),
    finished:sources.filter(source=>source.ready).map(item),issues:inspection.issues||[],...(inspection.blocked?{blocked:true}:{})};
}
// Added to a progress continuation that declared a wait: progress never waits, so the executor learns the one form that does.
const PROGRESS_WAIT_NOTE='\nprogress 一律立即續接，不會等待 waitMinutes；回合一結束主線就停工。下一步及等待期間可並行的工作現在就做；只有剩下的工作全部都必須等背景結果時，才以 waiting 結束（附 waitMinutes 與可觀察的 waitFor），由監督確認。';
// Every message the supervisor side sends the executor ends with this push (Jay 2026-11-09: 「我希望監督或背景程序可以每次
// 傳送訊息都積極Push主線「積極派出子代理」全面加速」). It restates the dispatch rule and grants no new authority.
const EXECUTOR_PUSH='全面加速：除非本訊息要求暫停或停止，請依積極派工（可派即派、不留空席），把已就緒、彼此獨立、資源不衝突的工作立刻派子代理並行，用滿可用席位；主線專注整合、收回成果與裁決。授權、範圍與資源隔離規則照舊。';
module.exports={allowed,inspect,waitChange,prompt,facts,PROGRESS_WAIT_NOTE,EXECUTOR_PUSH};
