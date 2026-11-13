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
// authorized at the start go ahead. Jay 2026-11-09 (「這些改法都OK」): inside the contract the supervisor decides by the
// spec; only these floors still wait on him, named by these labels on his dashboard. Of 139 questions he answered
// across four runs, 66 of 92 decisions took the recommendation and 13 more chose the option that asked less of him.
const KINDS={irreversible:'不可逆（改寫 Git 歷史、未授權的正式部署等）',paid:'付費（開工時沒授權或超出上限的）',delete:'刪除或永久改動既有資料（開發過程產物除外）',credential:'帳號或憑證（開工時沒授權的）',external:'正式對外發送（寄信、對客戶或公開發布；非測試）',
  prohibition:'推翻你的禁令',acceptance:'改驗收條文（縮窄、列例外、換證據）',user_action:'要你本人操作，或只有你知道的事實',major_change:'超出契約目標或範圍、沒有明確推薦的變更',gate:'你在契約自設的核准關卡'};
const FIELDS=['kind','ask','recommend','why','options'],OPS=['raise','reopen','withdraw','answer','delegate'];
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
    if(!fs.existsSync(file))return {file,open:[],delegated:[],closed:[],unpresented:[],...legacy(state)};
    try{ledger=load(run);}catch(error){return {file,error:error.message,open:[],delegated:[],closed:[],unpresented:[]};}
  }
  return {file,open:ledger.items.filter(isOpen).map(bare),delegated:delegatedOf(ledger),
    closed:ledger.items.filter(item=>!isOpen(item)&&item.status!=='delegated').map(item=>({key:item.key,status:item.status,ask:item.ask,
      answer:item.answer&&{choice:item.answer.choice,quote:item.answer.quote&&item.answer.quote.slice(0,300),amendmentId:item.answer.amendmentId,at:item.answer.at},
      withdrawn:item.withdrawn?.reason||null})),
    unpresented:ledger.items.filter(unpresented).map(item=>item.key)};
}
// What the supervisor decided in Jay's place, newest first, with the way back (Jay 2026-11-09: listed on the next push).
function delegatedOf(ledger){
  return ledger.items.filter(item=>item.status==='delegated').map(item=>({key:item.key,kind:item.kind||null,ask:item.ask,...item.delegated}))
    .sort((a,b)=>String(b.at).localeCompare(String(a.at)));
}
// One change file: raise new or updated items, reopen a closed one on a new fact, withdraw what the supervisor can
// decide after all, record Jay's answers, record what the supervisor decided in his place (delegate). Every check runs
// before the file is written, so a bad change writes nothing.
function apply(run,change,{binding,checkQuote,at=new Date().toISOString()}={}){
  need(binding,'Pending changes need the run binding');
  contractState.supervisorOnly(binding);
  need(change&&typeof change==='object'&&!Array.isArray(change)&&Object.keys(change).length&&Object.keys(change).every(name=>OPS.includes(name)&&Array.isArray(change[name])),
    'A pending change holds only raise, reopen, withdraw, answer or delegate lists');
  const ledger=load(run),byKey=new Map(ledger.items.map(item=>[item.key,item])),touched=new Set();
  // delegatedKeys: the keys this change decided for Jay; view's delegated lists every such decision in full.
  const result={raised:[],updated:[],unchanged:[],reopened:[],withdrawn:[],answered:[],delegatedKeys:[]};
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
  // snapshot (the amendment rule), or an amendment already recorded. Jay may also answer an item the supervisor
  // decided in his place; his words replace that decision.
  for(const item of change.answer||[]){
    const key=once(item?.key),old=byKey.get(key);
    need(old&&(isOpen(old)||old.status==='delegated'),'Answer needs an open or delegated key: '+key);
    if(text(item.amendmentId)){
      need(item.quote==null&&item.source==null,key+': an answer has one source: amendmentId, or quote (with source when it did not arrive this turn)');
      contractState.effective(run,binding);
      need(contractState.journal(run).some(row=>row.id===item.amendmentId),'Unknown amendment '+item.amendmentId+'; record it with supervise.cjs amend first');
    }else{
      need(text(item.quote),key+": an answer needs Jay's words (quote) or a recorded amendment (amendmentId)");
      if(item.source!=null)contractState.userSource(item.source,item.quote,binding.allowedRoots);
      else{need(typeof checkQuote==='function','No check for words received this turn');checkQuote(item.quote);}
    }
    if(old.status==='delegated')(old.history||=[]).push({at,status:old.status,delegated:old.delegated});
    Object.assign(old,{status:'answered',updatedAt:at,answer:{choice:text(item.choice)?item.choice.trim():null,quote:text(item.quote)?item.quote.trim():null,
      amendmentId:text(item.amendmentId)?item.amendmentId:null,source:item.source?{path:item.source.path,sha256:item.source.sha256}:null,at}});
    result.answered.push(key);
  }
  // A decision the supervisor made in Jay's place under the spec (Jay 2026-11-09): what was asked, what it chose, on
  // what basis, and how to undo it. An open item it can decide after all becomes delegated under the same key, and a
  // later delegate on the same key revises the decision.
  for(const item of change.delegate||[]){
    const key=once(item?.key),old=byKey.get(key);
    need(!old||isOpen(old)||old.status==='delegated',key+' is already '+old?.status+'; a delegated decision needs an open or delegated item, or a new key');
    for(const field of ['ask','choice','basis','revert'])need(text(item[field]),key+': a delegated decision needs '+field+' (revert says how Jay can undo it)');
    need(item.kind==null||Object.hasOwn(KINDS,item.kind),key+': kind must be one of '+Object.keys(KINDS).join(', '));
    const delegated={choice:item.choice.trim(),basis:item.basis.trim(),revert:item.revert.trim(),at};
    if(old){(old.history||=[]).push({at,...pick(old),status:old.status,...(old.delegated?{delegated:old.delegated}:{})});
      Object.assign(old,{status:'delegated',ask:item.ask.trim(),...(item.kind?{kind:item.kind}:{}),delegated,updatedAt:at});}
    else{twin(ledger,key,item.ask);
      const added={key,kind:item.kind||null,ask:item.ask.trim(),status:'delegated',raisedAt:at,updatedAt:at,presentedAt:null,answer:null,withdrawn:null,delegated,history:[]};
      ledger.items.push(added);byKey.set(key,added);}
    result.delegatedKeys.push(key);
  }
  store(run,ledger);
  return {...result,...view(run,{},ledger)};
}
// An answer that is itself an authorization or an acceptance change is recorded once: supervise.cjs amend takes the
// amendment plus pendingKeys (the open items it answers, each a key or {key, choice}) and closes them with its id. On
// 2026-10-15 IA closed 10 items with Jay's words and recorded the same answers as two amendments; every
// answer.amendmentId stayed empty. The keys are checked before the journal is written and never stored in it, so a
// retry of a recorded amendment closes only what is still open.
function amend(run,binding,input,{at,self}={}){
  need(input&&typeof input==='object'&&!Array.isArray(input),'An amendment is one JSON object');
  const {pendingKeys,...row}=input;
  need(pendingKeys===undefined||Array.isArray(pendingKeys),'pendingKeys lists the open pending items this amendment answers');
  if(!pendingKeys?.length)return contractState.append(run,binding,row,{self});
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
  const recorded=contractState.append(run,binding,row,{self});
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
// The questions themselves reach Jay's phone (Jay 2026-11-09, 推播一定送到、主線停下就推題目): each open item with the
// recommendation, why it waits on him and the choices, plus what the supervisor decided in his place since the last
// push. Before, a push said only 「有 5 題」; Jay asked twice (11/07 18:53, 02:11) to have the questions listed again.
const PUSH_LIMIT=3800,clip=(value,size)=>{const flat=String(value??'').replace(/\s+/g,' ').trim();return flat.length>size?flat.slice(0,size-1)+'…':flat;};
const hash=value=>require('node:crypto').createHash('sha256').update(String(value)).digest('hex');
const retryMs=()=>Number(process.env.LONG_TASK_PUSH_RETRY_MS)||10*60000;
// Pushed is kept per version: a question changed after its last push goes out again, an unchanged one does not, and
// answering one question does not re-push the rest.
const itemMark=item=>'item-'+item.key+'-'+hash(item.updatedAt).slice(0,12),delegatedMark=item=>'delegated-'+item.key+'-'+hash(item.delegated?.at).slice(0,12);
function pushText(title,open,delegated){
  const name='『'+(title||'監督對話')+'』',blocks=[],used=[];
  let size=0;const fits=block=>size+block.length+2<=PUSH_LIMIT-160;
  const head='【開發任務需要你決定】'+name+'有 '+open.length+' 題要你回答：';size+=head.length;
  let shown=0;
  for(const [index,item] of open.entries()){
    const block=[(index+1)+'. '+clip(item.ask,300),'建議：'+clip(item.recommend,200),'原因／影響：'+clip(item.why,200),
      ...(item.options?.length?['選項：'+item.options.map(option=>clip(option,60)).join('／')]:[])].join('\n');
    if(!fits(block))break;blocks.push(block);size+=block.length+2;shown++;
  }
  if(shown<open.length)blocks.push('另有 '+(open.length-shown)+' 題，請打開監督對話'+name+'查看。');
  blocks.push('直接在監督對話回覆，例如「1 照建議、2 選 B」。');
  if(delegated.length){
    const lines=['監督已依規格代決（不用回；要改回直接跟監督說）：'];
    for(const item of delegated){const line='- '+clip(item.ask,90)+'：'+clip(item.delegated.choice,90)+'（改回：'+clip(item.delegated.revert,70)+'）';
      if(size+lines.join('\n').length+line.length+2>PUSH_LIMIT)break;lines.push(line);used.push(item);}
    if(used.length<delegated.length)lines.push('另有 '+(delegated.length-used.length)+' 項代決，見監督儀表板。');
    if(used.length)blocks.push(lines.join('\n'));
  }
  return {text:[head,...blocks].join('\n\n'),delegated:used};
}
// One push per new or changed question, whoever notices first: the watcher once the supervisor has finished the event
// that raised it, or the supervisor's own card (shown). Each push lists every open item, so Jay never pieces the list
// together. A failed push is retried every 10 minutes, at most 3 more times, and stays visible (pushProblem).
async function pushOpen(run,{title,now=Date.now()}={}){
  let ledger;try{ledger=load(run);}catch(error){return {ok:false,skipped:true,error:error.message};}
  const open=ledger.items.filter(isOpen);
  if(!open.length)return {ok:true,skipped:true,reason:'nothing_open'};
  const notify=require('./notify.cjs');
  if(open.every(item=>notify.sent(run,itemMark(item))))return {ok:true,skipped:true,reason:'already_pushed'};
  const base='questions-'+hash(open.map(item=>item.key+'@'+item.updatedAt).sort().join(',')).slice(0,16);
  const keys=[base,base+'-r1',base+'-r2',base+'-r3'],records=keys.map(key=>notify.sent(run,key));
  if(records.some(record=>record?.ok))return {ok:true,skipped:true,key:base};
  const slot=records.findIndex(record=>!record),last=records.filter(Boolean).at(-1);
  if(slot<0)return {ok:false,skipped:true,key:base,error:last?.error||'retries used up'};
  if(last&&now-(Date.parse(last.at||last.claimedAt)||0)<retryMs())return {ok:false,skipped:true,key:base,error:last.error||'push in progress'};
  const fresh=ledger.items.filter(item=>item.status==='delegated'&&!notify.sent(run,delegatedMark(item)));
  const {text:body,delegated}=pushText(title,open,fresh);
  const sent=await notify.sendOnce(run,keys[slot],body);
  if(sent.ok)for(const key of [...open.map(itemMark),...delegated.map(delegatedMark)])notify.mark(run,key,{includedIn:keys[slot]});
  return {ok:sent.ok===true,skipped:Boolean(sent.skipped),key:keys[slot],count:open.length,delegated:delegated.length,error:sent.error||null,at:sent.at||null};
}
// The latest question push that did not get through, or null: the dashboard shows it at the top and the supervisor
// names it first when it next writes to Jay (Jay 2026-11-09). GDB 2026-11-06/08: 6 pushes never left, no one saw it.
function pushProblem(run){
  const dir=path.join(run,'notifications');let names;
  try{names=fs.readdirSync(dir).filter(name=>name.startsWith('questions-')&&name.endsWith('.json'));}catch{return null;}
  const records=names.map(name=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));}catch{return null;}}).filter(record=>record?.at)
    .sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  const latest=records.at(-1);
  return latest&&latest.ok!==true?{key:latest.key,at:latest.at,error:latest.error||'unknown'}:null;
}
// The supervisor's card to Jay goes to his phone too (Jay 2026-10-29), with the questions in full; the watcher may
// have pushed the same list already, and the same list is never pushed twice.
async function pushShown(run,result,title){
  const push=await pushOpen(run,{title});
  return {...result,push:{ok:push.ok===true,skipped:Boolean(push.skipped),error:push.error||null}};
}
module.exports={FILE,KINDS,load,view,apply,amend,ask,shown,pushShown,pushOpen,pushText,pushProblem};
