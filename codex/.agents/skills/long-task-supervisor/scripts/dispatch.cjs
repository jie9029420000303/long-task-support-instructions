#!/usr/bin/env node
const fs=require('node:fs');
const contractState=require('./contract-state.cjs');
const path=require('node:path');
const {parse}=require('./dispatch-audit.cjs');
const acceptance=require('./acceptance-audit.cjs');
const LISTS=['ready','inFlight','returned','blocked','completed','recurringRework'];
const USAGE='Usage: dispatch.cjs write ABSOLUTE_RUN ABSOLUTE_INPUT_JSON | summary ABSOLUTE_RUN | from-wp ABSOLUTE_RUN ABSOLUTE_STATE_DIR [--activity A] [--revision R] [--base ABSOLUTE_JSON] | mark ABSOLUTE_RUN ABSOLUTE_STATE_DIR PACKAGE_ID STATUS_JSON [same options]';

// Work-package files are the bookkeeping (Jay 2026-10-15). In GDB v1.2.0 the main line spent 99 minutes and 506 turns
// on records alone, rewriting snapshot JSON and a generator of its own by hand. Each wp/<id>.md carries one
// "[狀態] {json}" line; the snapshot is derived from those files, so a state change is one command.
// [共用資源] may span lines and use the orchestrator's Chinese prefixes (帳號:、瀏覽器:、DB: …); every key:value is a claim.
const KINDS={worktree:'worktree','工作區':'worktree',browser:'browser','瀏覽器':'browser',account:'account','帳號':'account',database:'database',db:'database',
  '資料庫':'database','資料':'database',host:'test_environment','主機':'test_environment',test_environment:'test_environment',env:'test_environment',environment:'test_environment','測試環境':'test_environment'};
const claims=text=>{const section=(text.match(/^\[共用資源\]([\s\S]*?)(?=\n\[|\n## |$(?![\s\S]))/m)||[])[1]||'';
  return [...section.matchAll(/([A-Za-z_\u4e00-\u9fff]+)[:：]([^\s，、,;；（）()「」]+)/g)].map(([,prefix,value])=>({key:prefix+':'+value,kind:KINDS[prefix]||KINDS[prefix.toLowerCase()]||'other'}));};
const listOf=text=>{const value=(text||'').trim();return !value||/^(無|none|-)$/i.test(value)?[]:value.split(/[、,，\s]+/).map(item=>item.trim()).filter(Boolean);};
const tagLine=(text,tag)=>{const match=text.match(new RegExp('^\\['+tag+'\\][ \\t]*(.*)$','m'));return match?match[1].trim():null;};
const packageId=(text,file)=>((tagLine(text,'工作包')||'').match(/id\s*[=＝]\s*([^；;\s]+)/)||[])[1]||path.basename(file,'.md');
function status(value,where){
  let state;try{state=typeof value==='string'?JSON.parse(value):value;}catch{throw Error(where+': the status must be one JSON object, for example {"list":"inFlight","handle":"agent:abc"}');}
  if(!state||typeof state!=='object'||!(LISTS.includes(state.list)||state.list==='archived'))throw Error(where+': status list must be one of '+LISTS.join(', ')+' or archived');
  return state;
}
function packagesFrom(stateDir,override){
  const dir=path.join(stateDir,'wp');
  const files=fs.readdirSync(dir).filter(name=>name.endsWith('.md')).sort().map(name=>path.join(dir,name));
  const out=Object.fromEntries(LISTS.map(name=>[name,[]])),missing=[];
  for(const file of files){
    const text=fs.readFileSync(file,'utf8'),raw=override?.file===file?override.state:tagLine(text,'狀態');
    if(raw===null){missing.push(file);continue;}
    const {list,...extra}=status(raw,file);if(list==='archived')continue;
    const header=tagLine(text,'工作包')||'',ids=listOf(tagLine(text,'驗收條目'));
    const record={id:packageId(text,file),...extra,evidence:[file,...(extra.evidence||[])]};
    if(ids.length&&!extra.acceptanceIds)record.acceptanceIds=ids;
    if(['ready','inFlight','blocked'].includes(list)&&!extra.exclusiveResources)record.exclusiveResources=claims(text);
    if(list==='ready'){if(!extra.dependencies)record.dependencies=listOf((header.match(/依賴\s*[：:]\s*([^；;]*)/)||[])[1]);
      if(record.independent===undefined)record.independent=true;if(record.safe===undefined)record.safe=true;}
    if(list==='returned'&&record.integrated===undefined)record.integrated=false;
    if(list==='completed'&&!record.acceptanceIds)record.acceptanceIds=[];
    out[list].push(record);
  }
  if(missing.length)throw Error('Add a [狀態] line to '+missing.join(', ')+' (packages that are no longer current take {"list":"archived"})');
  return out;
}
function build(run,binding,stateDir,options,override){
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');
  const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{},base=options.base?JSON.parse(fs.readFileSync(options.base,'utf8')):{};
  if(!previous.capacity&&!base.capacity)throw Error('The first snapshot needs --base ABSOLUTE_JSON with capacity (and acceptance when this run tracks it)');
  const packages=packagesFrom(stateDir,override);
  // Defaults keep missed dispatch visible: nothing in flight reads as waiting, so ready work still raises a review.
  const activity=options.activity||(packages.inFlight.length?'working':packages.returned.some(item=>!item.integrated)?'integrating':'waiting');
  return {...previous,...base,schemaVersion:1,executorId:binding.executorId,planningRevision:options.revision||base.planningRevision||previous.planningRevision||'wp',
    activity,updatedAt:new Date().toISOString(),packages};
}
function checked(run,binding,value){
  parse(value,binding);
  if(value.acceptance)acceptance.validate(value.acceptance,contractState.effective(run,binding));
  else if(binding.dispatchAudit?.acceptance||fs.existsSync(path.join(run,'acceptance-history.jsonl')))throw Error('Acceptance progress is missing from the current snapshot');
  return value;
}
let lock;
function save(run,binding,value){
  const output=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),temporary=output+'.tmp-'+process.pid;
  const lockFile=path.join(run,'dispatch-write.lock');
  try{fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,at:new Date().toISOString()})+'\n',{flag:'wx'});lock=lockFile;}catch(error){if(error.code==='EEXIST')throw Error('Dispatch writer is active or recovery is required: inspect '+lockFile+' and retry the same attempt IDs after the owner exits');throw error;}
  acceptance.record(run,value.acceptance,output);
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  fs.renameSync(temporary,output);
  // A short line per write, so a finished run shows when work waited while packages were ready or criteria open.
  const ids=list=>(list||[]).map(item=>item.id);
  fs.appendFileSync(path.join(run,'dispatch-history.jsonl'),JSON.stringify({at:new Date().toISOString(),planningRevision:value.planningRevision,activity:value.activity,
    ready:ids(value.packages.ready),inFlight:(value.packages.inFlight||[]).map(item=>({id:item.id,handle:item.handle})),blocked:ids(value.packages.blocked),
    openCriteria:(value.acceptance?.items||[]).filter(item=>!['PASS','EXCLUDED'].includes(item.status)).map(item=>item.id)})+'\n');
  return output;
}
const args=process.argv.slice(2),[command,runArg]=args;
const flag=name=>{const at=args.indexOf('--'+name);return at>=0?args[at+1]:undefined;};
try{
  const absolute=value=>path.isAbsolute(value||'');
  const positional=args.filter((value,at)=>!value.startsWith('--')&&!(at>0&&args[at-1].startsWith('--')));
  const valid={write:absolute(positional[2]),summary:true,'from-wp':absolute(positional[2]),mark:absolute(positional[2])&&positional[3]&&positional[4]}[command];
  if(!valid||!absolute(runArg)||(flag('base')!==undefined&&!absolute(flag('base'))))throw Error(USAGE);
  const run=path.resolve(runArg),binding=JSON.parse(fs.readFileSync(path.join(run,'binding.json'),'utf8'));
  if(!binding.dispatchAudit?.enabled&&!fs.existsSync(path.join(run,'DISPATCH_AUDIT')))throw Error('Dispatch auditing is not attached to this run');
  if(command==='summary'){const snapshot=checked(run,binding,JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),'utf8')));
    console.log(JSON.stringify(acceptance.summarize(run,snapshot.acceptance)));}
  else if(command==='write'){const value=checked(run,binding,JSON.parse(fs.readFileSync(positional[2],'utf8')));
    console.log(JSON.stringify({written:true,path:save(run,binding,value),planningRevision:value.planningRevision}));}
  else{
    const stateDir=path.resolve(positional[2]),options={activity:flag('activity'),revision:flag('revision'),base:flag('base')};
    let override,wpFile,wpText;
    if(command==='mark'){
      const id=positional[3],state=status(positional[4],'STATUS_JSON'),dir=path.join(stateDir,'wp');
      wpFile=[path.join(dir,id+'.md'),...fs.readdirSync(dir).filter(name=>name.endsWith('.md')).sort().map(name=>path.join(dir,name))]
        .find(file=>fs.existsSync(file)&&packageId(fs.readFileSync(file,'utf8'),file)===id);
      if(!wpFile)throw Error('No work-package file for '+id+' under '+dir);
      const text=fs.readFileSync(wpFile,'utf8'),line='[狀態] '+JSON.stringify(state);
      wpText=/^\[狀態\].*$/m.test(text)?text.replace(/^\[狀態\].*$/m,()=>line):/^\[工作包\].*$/m.test(text)?text.replace(/^\[工作包\].*$/m,match=>match+'\n'+line):line+'\n'+text;
      override={file:wpFile,state};
    }
    // Validate the whole snapshot before touching the package file, so a rejected change leaves both as they were.
    const value=checked(run,binding,build(run,binding,stateDir,options,override));
    if(wpFile){const temporary=wpFile+'.tmp-'+process.pid;fs.writeFileSync(temporary,wpText,{flag:'wx'});fs.renameSync(temporary,wpFile);}
    const counts=Object.fromEntries(LISTS.map(name=>[name,value.packages[name].length]));
    console.log(JSON.stringify({written:true,path:save(run,binding,value),planningRevision:value.planningRevision,activity:value.activity,packages:counts}));
  }
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(lock)fs.unlinkSync(lock);}
