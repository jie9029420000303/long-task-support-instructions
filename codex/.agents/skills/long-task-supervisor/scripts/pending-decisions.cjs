// Decisions waiting on Jay live in a run file the program keeps, not in chat memory (Jay 2026-10-14:「這件事情不要留存
// 在記憶中，就不會被壓縮了…每次產生新問題，就去確認下已經存下的問題是否有重複」). Before it, decisions carried free-text
// pendingApprovals: the 2026-10-13 GDB supervisor reworded one question 7 ways in 13 decisions, put 4 of 7 known items
// on one card and the other 3 on a second, and its status pane kept 2 already-decided items for 22 more decisions.
// Only the supervisor's chat writes the ledger; watchers, the dashboard and the status panel only read it.
const fs=require('node:fs'),path=require('node:path');
const contractState=require('./contract-state.cjs');
const FILE='pending-decisions.json';
// Only these wait on Jay (event-review gate 1, SPEC 16); the supervisor decides everything else itself. The kind makes
// the supervisor say why Jay must decide; it does not prove it.
// Jay 2026-10-29: development leftovers are deleted without asking; Git work, test-labelled sends and anything he
// authorized at the start go ahead. What still waits on him is named by these labels on his dashboard.
const KINDS={irreversible:'不可逆（改寫 Git 歷史、未授權的正式部署等）',paid:'付費（開工時沒授權的）',delete:'刪除或永久改動既有資料（開發過程產物除外）',credential:'帳號或憑證（開工時沒授權的）',external:'正式對外發送（非測試）',
  prohibition:'推翻你的禁令',acceptance:'改驗收條文',user_action:'要你本人操作',major_change:'上層規則要先確認的重大變更'};
const FIELDS=['kind','ask','recommend','why','options'],OPS=['raise','reopen','withdraw','answer'];
const KEY=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const need=(ok,message)=>{if(!ok)throw Error(message);};
const text=value=>typeof value==='string'&&value.trim();
const squash=value=>String(value).replace(/\s+/g,'');
const isOpen=item=>item.status==='open';
const pick=item=>Object.fromEntries(FIELDS.map(field=>[field,item[field]]));
const bare=({history,...item})=>item;
// Not yet on a card, or changed after the last card that listed it.
const unpresented=item=>isOpen(item)&&(!item.presentedAt||item.updatedAt>item.presentedAt);
function load(run){
  const file=path.join(run,FILE);if(!fs.existsSync(file))return {schema:1,items:[]};
  try{const ledger=JSON.parse(fs.readFileSync(file,'utf8'));need(Array.isArray(ledger?.items),'no items list');return ledger;}
  catch(error){throw Error(FILE+' is unreadable ('+error.message+'); restore it before changing the ledger');}
}
function store(run,ledger){const file=path.join(run,FILE);fs.writeFileSync(file+'.tmp',JSON.stringify(ledger,null,2)+'\n');fs.renameSync(file+'.tmp',file);}
function check(value,key){
  need(Object.hasOwn(KINDS,value.kind),key+': kind must be one of '+Object.keys(KINDS).join(', ')+'; the supervisor decides anything else itself');
  for(const field of ['ask','recommend','why'])need(text(value[field]),key+': a pending item needs '+field);
  const options=value.options===undefined?[]:value.options;
  need(Array.isArray(options)&&options.every(text),key+': options must be a list of choices');
  return {kind:value.kind,ask:value.ask.trim(),recommend:value.recommend.trim(),why:value.why.trim(),options:options.map(option=>option.trim())};
}
// Code catches the same key and the same wording; the model catches rewordings from the full list in its context.
function twin(ledger,key,ask){
  const other=ledger.items.find(item=>item.key!==key&&squash(item.ask)===squash(ask));
  if(other)need(false,isOpen(other)?'The same question is already open as '+other.key+'; update that key'
    :'The same question was already '+other.status+' as '+other.key+'; if a new fact changes it, reopen '+other.key);
}
// Runs started before the ledger kept pending items as free text in decisions. Show them until the supervisor
// registers what is still open; GDB used the field as a full list and IA as a delta, so nothing is imported for it.
function legacy(state){
  const texts=[];
  for(const item of Object.values(state?.resolved||{}))
    for(const value of Array.isArray(item?.decision?.pendingApprovals)?item.decision.pendingApprovals:[])if(text(value)&&!texts.includes(value))texts.push(value);
  return texts.length?{legacy:{pendingApprovals:texts,note:'舊版決策裡的待核准文字：仍未決的用 supervise.cjs pending 登記一次，已解決的不用登記；'+
    '登記後（都不用登記時送 {"raise":[]}）這段就不再出現'}}:{};
}
// The whole list for every wake: open items in full, closed ones with Jay's answer or the withdrawal reason.
function view(run,state={},ledger=null){
  const file=path.join(run,FILE);
  if(!ledger){
    if(!fs.existsSync(file))return {file,open:[],closed:[],unpresented:[],...legacy(state)};
    try{ledger=load(run);}catch(error){return {file,error:error.message,open:[],closed:[],unpresented:[]};}
  }
  return {file,open:ledger.items.filter(isOpen).map(bare),
    closed:ledger.items.filter(item=>!isOpen(item)).map(item=>({key:item.key,status:item.status,ask:item.ask,
      answer:item.answer&&{choice:item.answer.choice,quote:item.answer.quote&&item.answer.quote.slice(0,300),amendmentId:item.answer.amendmentId,at:item.answer.at},
      withdrawn:item.withdrawn?.reason||null})),
    unpresented:ledger.items.filter(unpresented).map(item=>item.key)};
}
// One change file: raise new or updated items, reopen a closed one on a new fact, withdraw what the supervisor can
// decide after all, record Jay's answers. Every check runs before the file is written, so a bad change writes nothing.
function apply(run,change,{binding,checkQuote,at=new Date().toISOString()}={}){
  need(binding,'Pending changes need the run binding');
  contractState.supervisorOnly(binding);
  need(change&&typeof change==='object'&&!Array.isArray(change)&&Object.keys(change).length&&Object.keys(change).every(name=>OPS.includes(name)&&Array.isArray(change[name])),
    'A pending change holds only raise, reopen, withdraw or answer lists');
  const ledger=load(run),byKey=new Map(ledger.items.map(item=>[item.key,item])),touched=new Set();
  const result={raised:[],updated:[],unchanged:[],reopened:[],withdrawn:[],answered:[]};
  const once=key=>{need(typeof key==='string'&&KEY.test(key)&&!touched.has(key),'Each item needs one stable key (letters, digits, - or _), once per change: '+key);touched.add(key);return key;};
  for(const item of change.raise||[]){
    const key=once(item?.key),old=byKey.get(key),value=check(item,key);
    need(!old||isOpen(old),key+' is already '+old?.status+'; if a new fact changes the question, reopen it');
    twin(ledger,key,value.ask);
    if(!old){const added={key,...value,status:'open',raisedAt:at,updatedAt:at,presentedAt:null,answer:null,withdrawn:null,history:[]};
      ledger.items.push(added);byKey.set(key,added);result.raised.push(key);continue;}
    // The same content again is not news: no history and no new card (GDB copied its list into 23 of 53 decisions).
    if(JSON.stringify(pick(old))===JSON.stringify(value)){result.unchanged.push(key);continue;}
    (old.history||=[]).push({at,...pick(old)});Object.assign(old,value,{updatedAt:at});result.updated.push(key);
  }
  for(const item of change.reopen||[]){
    const key=once(item?.key),old=byKey.get(key);
    need(old&&!isOpen(old),key+(old?' is still open; update it with raise':' is not in the ledger; raise it'));
    need(text(item.fact),key+': reopen needs the new fact that changes the question');
    const value=check(Object.fromEntries(FIELDS.map(field=>[field,item[field]===undefined?old[field]:item[field]])),key);
    twin(ledger,key,value.ask);
    (old.history||=[]).push({at,...pick(old),status:old.status,answer:old.answer,withdrawn:old.withdrawn,fact:item.fact.trim()});
    Object.assign(old,value,{status:'open',updatedAt:at,answer:null,withdrawn:null});result.reopened.push(key);
  }
  for(const item of change.withdraw||[]){
    const key=once(item?.key),old=byKey.get(key);
    need(old&&isOpen(old),'Withdraw needs an open key: '+key);
    need(text(item.reason),key+': withdraw needs why the supervisor can decide it and on what authority');
    Object.assign(old,{status:'withdrawn',withdrawn:{reason:item.reason.trim(),at},updatedAt:at});result.withdrawn.push(key);
  }
  // An answer is Jay's words, never the supervisor's reading: received this turn (the pause rule), kept in a saved
  // snapshot (the amendment rule), or an amendment already recorded.
  for(const item of change.answer||[]){
    const key=once(item?.key),old=byKey.get(key);
    need(old&&isOpen(old),'Answer needs an open key: '+key);
    if(text(item.amendmentId)){
      need(item.quote==null&&item.source==null,key+': an answer has one source: amendmentId, or quote (with source when it did not arrive this turn)');
      contractState.effective(run,binding);
      need(contractState.journal(run).some(row=>row.id===item.amendmentId),'Unknown amendment '+item.amendmentId+'; record it with supervise.cjs amend first');
    }else{
      need(text(item.quote),key+": an answer needs Jay's words (quote) or a recorded amendment (amendmentId)");
      if(item.source!=null)contractState.userSource(item.source,item.quote,binding.allowedRoots);
      else{need(typeof checkQuote==='function','No check for words received this turn');checkQuote(item.quote);}
    }
    Object.assign(old,{status:'answered',updatedAt:at,answer:{choice:text(item.choice)?item.choice.trim():null,quote:text(item.quote)?item.quote.trim():null,
      amendmentId:text(item.amendmentId)?item.amendmentId:null,source:item.source?{path:item.source.path,sha256:item.source.sha256}:null,at}});
    result.answered.push(key);
  }
  store(run,ledger);
  return {...result,...view(run,{},ledger)};
}
// An answer that is itself an authorization or an acceptance change is recorded once: supervise.cjs amend takes the
// amendment plus pendingKeys (the open items it answers, each a key or {key, choice}) and closes them with its id. On
// 2026-10-15 IA closed 10 items with Jay's words and recorded the same answers as two amendments; every
// answer.amendmentId stayed empty. The keys are checked before the journal is written and never stored in it, so a
// retry of a recorded amendment closes only what is still open.
function amend(run,binding,input,{at}={}){
  need(input&&typeof input==='object'&&!Array.isArray(input),'An amendment is one JSON object');
  const {pendingKeys,...row}=input;
  need(pendingKeys===undefined||Array.isArray(pendingKeys),'pendingKeys lists the open pending items this amendment answers');
  if(!pendingKeys?.length)return contractState.append(run,binding,row);
  need(binding,'Amendments need the run binding');
  contractState.supervisorOnly(binding);
  const byKey=new Map(load(run).items.map(item=>[item.key,item])),seen=new Set(),answer=[],already=[];
  for(const entry of pendingKeys){
    const key=typeof entry==='string'?entry:entry?.key,choice=typeof entry==='string'?null:entry?.choice;
    need(typeof key==='string'&&KEY.test(key)&&!seen.has(key),'Each pending key once (letters, digits, - or _): '+key);seen.add(key);
    need(choice==null||text(choice),key+': choice must be text');
    const item=byKey.get(key);
    need(item,key+' is not in the pending ledger');
    if(item.status==='answered'&&item.answer?.amendmentId===row.id){already.push(key);continue;}
    need(isOpen(item),key+' is already '+item.status+'; an amendment closes only open items');
    answer.push({key,amendmentId:row.id,...(text(choice)?{choice}:{})});
  }
  const recorded=contractState.append(run,binding,row);
  const closed=answer.length?apply(run,{answer},{binding,at}):{answered:[],...view(run,{},load(run))};
  return {...recorded,pending:{...closed,alreadyAnswered:already}};
}
// What a card must carry: every open item. new lists the keys not yet on a card or changed since; repeat means the
// last card already showed all of them unchanged, so there is nothing to ask again. Reading never stamps.
function ask(run){
  const open=load(run).items.filter(isOpen);
  return {file:path.join(run,FILE),items:open.map(bare),new:open.filter(unpresented).map(item=>item.key),repeat:open.length>0&&!open.some(unpresented)};
}
// Stamp a card only when it listed every open item exactly once; stamping a subset would hide the rest behind
// repeat:true (the 2026-10-13 GDB card at 22:11 carried 4 of 7 known items).
function shown(run,keys,{binding,at=new Date().toISOString()}={}){
  need(binding,'Stamping a card needs the run binding');
  contractState.supervisorOnly(binding);
  const ledger=load(run),open=ledger.items.filter(isOpen).map(item=>item.key);
  need(open.length,'Nothing is open in the pending ledger');
  const listed=Array.isArray(keys)?keys:[],missing=open.filter(key=>!listed.includes(key)),extra=listed.filter(key=>!open.includes(key));
  const twice=listed.filter((key,index)=>listed.indexOf(key)!==index);
  need(!missing.length&&!extra.length&&!twice.length,'A card lists every open item exactly once'+(missing.length?'; missing '+missing.join(', '):'')+
    (extra.length?'; not open '+extra.join(', '):'')+(twice.length?'; listed twice '+twice.join(', '):''));
  for(const item of ledger.items.filter(isOpen))item.presentedAt=at;
  store(run,ledger);
  return {shown:open,at};
}
// One push through 「Jay的小秘書」 per batch put to Jay (Jay 2026-10-29); the same set of open items is never pushed twice.
async function pushShown(run,result,title){
  const keys=[...result.shown].sort(),key='pending-'+require('node:crypto').createHash('sha256').update(keys.join(',')).digest('hex').slice(0,16);
  const sent=await require('./notify.cjs').sendOnce(run,key,'【開發任務需要你決定】『'+(title||'監督對話')+'』有 '+keys.length+' 題要你回答，請打開該監督對話查看。');
  return {...result,push:{ok:sent.ok===true,skipped:Boolean(sent.skipped),error:sent.error||null}};
}
module.exports={FILE,KINDS,load,view,apply,amend,ask,shown,pushShown};
