#!/usr/bin/env node
const fs=require('node:fs');
const contractState=require('./contract-state.cjs');
const path=require('node:path');
const {parse,planningBasis,planReview}=require('./dispatch-audit.cjs');
const acceptance=require('./acceptance-audit.cjs');
const LISTS=['ready','inFlight','returned','blocked','completed','recurringRework'];
const USAGE='Usage: dispatch.cjs write ABSOLUTE_RUN ABSOLUTE_INPUT_JSON | summary ABSOLUTE_RUN | reconcile ABSOLUTE_RUN | from-wp ABSOLUTE_RUN ABSOLUTE_STATE_DIR [--activity A] [--revision R] [--base ABSOLUTE_JSON] [--reviewed REASON] | mark ABSOLUTE_RUN ABSOLUTE_STATE_DIR PACKAGE_ID STATUS_JSON [--estimate MODEL[:OUTPUT_TOKENS[:TOOL_MINUTES]]] [same options] | collect ABSOLUTE_RUN ABSOLUTE_STATE_DIR PACKAGE_ID ABSOLUTE_RESULT_JSON [PACKAGE_ID ABSOLUTE_RESULT_JSON ...] [same options]';

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
// 收包 (Jay 2026-10-29): taking a package back was four separate steps (status line, evidence, acceptance table,
// snapshot), each a round of hand-written JSON. One result file now does all four: {"status":{list,...,evidence},
// "acceptance":[{id,status,evidence,lastAttempt?}]}. Every path and ID is checked before anything is written.
function collected(file){
  let input;try{input=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){throw Error('RESULT_JSON: '+error.message);}
  const state=status(input?.status,'RESULT_JSON status');
  const updates=input.acceptance===undefined?[]:input.acceptance;
  if(!Array.isArray(updates))throw Error('RESULT_JSON acceptance must be a list of {id,status,evidence}');
  const paths=[...(state.evidence||[]),...updates.flatMap(item=>item?.evidence||[])].filter(item=>typeof item==='string'&&item.startsWith('/'));
  const missing=paths.filter(item=>!fs.existsSync(item));
  if(missing.length)throw Error('RESULT_JSON evidence does not exist: '+missing.join(', '));
  return {state,updates};
}
// Fewer bookkeeping calls (Jay 2026-11-12; A WebRPA's main line made 516 collect and 150 estimate calls in five days,
// 160 collects within 3 minutes of another and 81 estimates next to a mark, each call carrying its whole context):
// collect takes several packages in one validated write, and mark --estimate fills the in-flight baseline with the
// same formula as pace.cjs estimate.
function estimated(binding,state,spec){
  if(spec===undefined)return state;
  const match=/^(.+?)(?::(\d+(?:\.\d+)?))?(?::(\d+(?:\.\d+)?))?$/.exec(spec.trim());
  if(!match||state.list!=='inFlight')throw Error('--estimate MODEL[:OUTPUT_TOKENS[:TOOL_MINUTES]] applies to a package marked inFlight');
  const pace=require('./pace.cjs');
  return {...state,baseline:{...pace.baseline({model:match[1],estimatedOutputTokens:Number(match[2]),toolMinutes:Number(match[3]||0)},pace.speed(pace.agentRuns(binding))),startedAt:new Date().toISOString()}};
}
function applyAcceptance(value,updates){
  if(!updates.length)return;
  if(!value.acceptance)throw Error('The snapshot has no acceptance table yet; write it once with --base before collecting results into it');
  const items=value.acceptance.items=value.acceptance.items.map(item=>({...item}));
  for(const update of updates){
    const item=items.find(entry=>entry.id===update?.id);
    if(!item)throw Error('RESULT_JSON acceptance names '+(update?.id||'no id')+', which is not in the acceptance table');
    item.status=update.status;item.evidence=update.evidence;
    if(update.lastAttempt)item.lastAttempt=update.lastAttempt;
  }
}
function packagesFrom(stateDir,overrides){
  const dir=path.join(stateDir,'wp');
  const realDir=fs.realpathSync(dir);
  const files=fs.readdirSync(dir).filter(name=>name.endsWith('.md')).sort().map(name=>{const file=path.join(dir,name);
    if(path.dirname(fs.realpathSync(file))!==realDir)throw Error('Work-package file leaves its trusted directory');return file;});
  const out=Object.fromEntries(LISTS.map(name=>[name,[]])),missing=[];
  for(const file of files){
    const text=fs.readFileSync(file,'utf8'),over=(overrides||[]).find(item=>item.file===file),raw=over?over.state:tagLine(text,'狀態');
    if(raw===null){missing.push(file);continue;}
    const {list,...extra}=status(raw,file);if(list==='archived')continue;
    const header=tagLine(text,'工作包')||'',ids=listOf(tagLine(text,'驗收條目'));
    const record={id:packageId(text,file),...extra,evidence:[file,...(extra.evidence||[])]};
    if(ids.length&&!extra.acceptanceIds)record.acceptanceIds=ids;
    if(['ready','inFlight','blocked'].includes(list)&&!extra.exclusiveResources)record.exclusiveResources=claims(text);
    if(['ready','inFlight','blocked'].includes(list)&&!extra.dependencies)record.dependencies=listOf((header.match(/依賴\s*[：:]\s*([^；;]*)/)||[])[1]);
    if(list==='ready'){
      if(record.independent===undefined)record.independent=true;if(record.safe===undefined)record.safe=true;}
    if(list==='returned'&&record.integrated===undefined)record.integrated=false;
    if(list==='completed'&&!record.acceptanceIds)record.acceptanceIds=[];
    out[list].push(record);
  }
  if(missing.length)throw Error('Add a [狀態] line to '+missing.join(', ')+' (packages that are no longer current take {"list":"archived"})');
  return out;
}
function trustedPackageDir(binding,stateDir){
  const dir=fs.realpathSync(path.join(stateDir,'wp'));
  const roots=(binding.allowedRoots||[]).map(root=>fs.realpathSync(root));
  if(!roots.some(root=>dir===root||dir.startsWith(root+path.sep)))throw Error('Work-package directory is outside allowed roots');
  return dir;
}
function build(run,binding,stateDir,options,overrides,packageDir){
  const file=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json');
  const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{},base=options.base?JSON.parse(fs.readFileSync(options.base,'utf8')):{};
  if(!previous.capacity&&!base.capacity)throw Error('The first snapshot needs --base ABSOLUTE_JSON with capacity (and acceptance when this run tracks it)');
  const packages=packagesFrom(stateDir,overrides);
  // Defaults keep missed dispatch visible: nothing in flight reads as waiting, so ready work still raises a review.
  const activity=options.activity||(packages.inFlight.length?'working':packages.returned.some(item=>!item.integrated)?'integrating':'waiting');
  return {...previous,...base,schemaVersion:1,executorId:binding.executorId,planningRevision:options.revision||base.planningRevision||previous.planningRevision||'wp',
    activity,updatedAt:new Date().toISOString(),packages,workPackageDirectory:packageDir};
}
function checked(run,binding,value){
  parse(value,binding);
  if(value.acceptance)acceptance.validate(value.acceptance,contractState.effective(run,binding));
  else if(binding.dispatchAudit?.acceptance||fs.existsSync(path.join(run,'acceptance-history.jsonl')))throw Error('Acceptance progress is missing from the current snapshot');
  return value;
}
function reviewed(value,binding,reason){
  if(reason!==undefined){if(!reason.trim())throw Error('--reviewed needs the actual reconciliation reason');
    value.planningReview={basis:planningBasis(binding),reason,at:new Date().toISOString()};}
  return value;
}
let lock;
function acquire(run){
  if(lock)return;
  const lockFile=path.join(run,'dispatch-write.lock');
  try{fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,at:new Date().toISOString()})+'\n',{flag:'wx'});lock=lockFile;}catch(error){if(error.code==='EEXIST')throw Error('Dispatch writer is active or recovery is required: inspect '+lockFile+' and retry the same attempt IDs after the owner exits');throw error;}
}
function save(run,binding,value){
  const output=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),temporary=output+'.tmp-'+process.pid;
  acquire(run);
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
  const valid={write:absolute(positional[2]),summary:true,reconcile:true,'from-wp':absolute(positional[2]),mark:absolute(positional[2])&&positional[3]&&positional[4],
    collect:absolute(positional[2])&&positional.length>=5&&positional.length%2===1&&positional.slice(3).every((value,at)=>at%2?absolute(value):Boolean(value))}[command];
  if(!valid||!absolute(runArg)||(flag('base')!==undefined&&!absolute(flag('base'))))throw Error(USAGE);
  const run=path.resolve(runArg),binding=JSON.parse(fs.readFileSync(path.join(run,'binding.json'),'utf8'));
  if(!binding.dispatchAudit?.enabled&&!fs.existsSync(path.join(run,'DISPATCH_AUDIT')))throw Error('Dispatch auditing is not attached to this run');
  if(command==='summary'){const snapshot=checked(run,binding,JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),'utf8')));
    console.log(JSON.stringify(acceptance.summarize(run,snapshot.acceptance)));}
  else if(command==='reconcile'){const snapshot=checked(run,binding,JSON.parse(fs.readFileSync(path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),'utf8')));
    console.log(JSON.stringify(planReview(snapshot,binding)));}
  else if(command==='write'){const value=checked(run,binding,reviewed(JSON.parse(fs.readFileSync(positional[2],'utf8')),binding,flag('reviewed')));
    console.log(JSON.stringify({written:true,path:save(run,binding,value),planningRevision:value.planningRevision,reconciliation:planReview(value,binding)}));}
  else{
    const stateDir=path.resolve(positional[2]),options={activity:flag('activity'),revision:flag('revision'),base:flag('base')};
    const packageDir=trustedPackageDir(binding,stateDir);
    acquire(run);
    const overrides=[],updates=[];
    if(command==='mark'||command==='collect'){
      const pairs=command==='collect'?positional.slice(3):[positional[3],positional[4]],dir=path.join(stateDir,'wp');
      for(let at=0;at<pairs.length;at+=2){
        const id=pairs[at],result=command==='collect'?collected(pairs[at+1]):{state:estimated(binding,status(pairs[at+1],'STATUS_JSON'),flag('estimate')),updates:[]};
        if(!/^[A-Za-z0-9_-]+$/.test(id))throw Error('Invalid work-package ID');
        const wpFile=[path.join(dir,id+'.md'),...fs.readdirSync(dir).filter(name=>name.endsWith('.md')).sort().map(name=>path.join(dir,name))]
          .find(file=>fs.existsSync(file)&&path.dirname(fs.realpathSync(file))===packageDir&&packageId(fs.readFileSync(file,'utf8'),file)===id);
        if(!wpFile)throw Error('No work-package file for '+id+' under '+dir);
        if(overrides.some(item=>item.file===wpFile))throw Error('Work package '+id+' is named twice in one collect');
        const text=fs.readFileSync(wpFile,'utf8'),line='[狀態] '+JSON.stringify(result.state);
        overrides.push({file:wpFile,state:result.state,
          text:/^\[狀態\].*$/m.test(text)?text.replace(/^\[狀態\].*$/m,()=>line):/^\[工作包\].*$/m.test(text)?text.replace(/^\[工作包\].*$/m,match=>match+'\n'+line):line+'\n'+text});
        updates.push(...result.updates);
      }
    }
    // Validate the whole snapshot before touching any package file, so a rejected change leaves everything as it was.
    const draft=build(run,binding,stateDir,options,overrides,packageDir);applyAcceptance(draft,updates);reviewed(draft,binding,flag('reviewed'));
    const value=checked(run,binding,draft);
    for(const item of overrides){const temporary=item.file+'.tmp-'+process.pid;fs.writeFileSync(temporary,item.text,{flag:'wx'});fs.renameSync(temporary,item.file);}
    const counts=Object.fromEntries(LISTS.map(name=>[name,value.packages[name].length]));
    console.log(JSON.stringify({written:true,path:save(run,binding,value),planningRevision:value.planningRevision,activity:value.activity,packages:counts,reconciliation:planReview(value,binding),
      ...(command==='collect'?{acceptance:updates.map(item=>({id:item.id,status:item.status}))}:{})}));
  }
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(lock)fs.unlinkSync(lock);}
