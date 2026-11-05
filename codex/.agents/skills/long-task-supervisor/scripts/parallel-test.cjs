// Identify only explicit whole-gate commands or a shell comment intentionally attached to a real test call.
// A call is a lead, not evidence of available work or a violation. Never persist command text or tool output.
const fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');

// Minimal shell tokenization: recognize a directly invoked gate, not a quoted example, cat, grep or editor.
// Complex shell syntax is deliberately left unknown rather than guessed.
function segments(command){
  // Heredocs contain data that can look like shell commands; do not guess their boundaries.
  if(command.includes('<<'))return [];
  const result=[];let words=[],word='',quote=null,escaped=false,inWord=false;
  const flush=()=>{if(inWord){words.push(word);word='';inWord=false;}};
  const end=()=>{flush();if(words.length)result.push(words);words=[];};
  for(let i=0;i<command.length;i++){
    const ch=command[i];
    if(escaped){word+=ch;inWord=true;escaped=false;continue;}
    if(ch==='\\'&&quote!=="'"){escaped=true;inWord=true;continue;}
    if(quote){if(ch===quote)quote=null;else word+=ch;inWord=true;continue;}
    if(ch==='"'||ch==="'"){quote=ch;inWord=true;continue;}
    if(ch==='#'&&!inWord){while(i<command.length&&command[i]!=='\n')i++;end();continue;}
    if(ch===';'||ch==='|'||ch==='&'||ch==='\n'){end();continue;}
    if(/\s/.test(ch)){flush();continue;}
    word+=ch;inWord=true;
  }
  if(quote||escaped)return [];
  end();return result;
}
function gateCommand(words){
  let i=0;while(i<words.length&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))i++;
  if(path.basename(words[i]||'')==='env'){i++;while(i<words.length&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))i++;}
  let executable=words[i++]||'';
  if(/^(?:ba|z|da)?sh$/.test(path.basename(executable))){
    while(i<words.length&&/^-[A-Za-z]+$/.test(words[i])){if(words[i].includes('c'))return false;i++;}
    executable=words[i]||'';
  }
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*-gate\.sh$/.test(path.basename(executable));
}
function recognizable(command){
  if(typeof command!=='string')return false;
  const marked=/^\s*#\s*LONG_TASK_LONG_TEST\s*\r?\n/.test(command);
  // A marked command can legitimately use a heredoc (e.g. node - <<'JS'). Inspect only the shell prefix;
  // the heredoc body is data and is never scanned for gate-shaped text.
  if(marked&&command.includes('<<'))return segments(command.slice(0,command.indexOf('<<'))).some(words=>{
    let i=0;while(i<words.length&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))i++;return Boolean(words[i]);
  });
  const cmds=segments(command);
  return marked?cmds.length>0:cmds.some(gateCommand);
}
// A code-mode wrapper is executable JavaScript, not a shell command. Do not extract cmd-like text from a
// quoted example, comment, conditional, callback, short-circuit, or function body. Only a conservative subset
// of top-level direct `await tools.exec_command({cmd: <literal>})` calls is recognized; all other code is unknown.
function jsTokens(input){
  const tokens=[];let i=0;
  while(i<input.length){
    const ch=input[i];if(/\s/.test(ch)){i++;continue;}
    if(ch==='/'&&input[i+1]==='/'){i+=2;while(i<input.length&&input[i]!=='\n')i++;continue;}
    if(ch==='/'&&input[i+1]==='*'){const end=input.indexOf('*/',i+2);if(end<0)return null;i=end+2;continue;}
    // JavaScript regex literals and division are intentionally unsupported: treating regex contents as code
    // could mistake a literal example for an actual tool call. Paths inside command strings are unaffected.
    if(ch==='/')return null;
    if(ch==='"'||ch==="'"||ch==='`'){
      let value='',closed=false;i++;
      while(i<input.length){const c=input[i++];if(c===ch){closed=true;break;}
        if(c==='\\'){if(i>=input.length)return null;const next=input[i++];value+=({n:'\n',r:'\r',t:'\t'})[next]??next;}
        else value+=c;}
      if(!closed)return null;
      // Nested template expressions are deliberately unsupported; otherwise a backtick inside ${...} could
      // cause literal text to be tokenized as an executable statement.
      if(ch==='`'&&value.replace(/\$\{[^{}]*\}/g,'').includes('${'))return null;
      tokens.push({kind:'string',value});continue;
    }
    if(/[A-Za-z_$]/.test(ch)){let end=i+1;while(end<input.length&&/[A-Za-z0-9_$]/.test(input[end]))end++;tokens.push({kind:'id',value:input.slice(i,end)});i=end;continue;}
    const pair=input.slice(i,i+2);if(['=>','&&','||','??','?.'].includes(pair)){tokens.push({kind:'punct',value:pair});i+=2;continue;}
    tokens.push({kind:'punct',value:ch});i++;
  }
  return tokens;
}
function wrapperCommands(input){
  if(typeof input!=='string')return [];
  const tokens=jsTokens(input);if(!tokens)return [];
  if(tokens.some(token=>token.kind==='id'&&['if','else','for','while','switch','function','class','async','return','throw','try','catch','do','exit'].includes(token.value)||
    token.kind==='punct'&&['=>','&&','||','??','?.','?'].includes(token.value)))return [];
  const result=[];let braces=0,parens=0,brackets=0;
  for(let i=0;i<tokens.length;i++){
    const v=tokens[i].value;
    if(!braces&&!parens&&!brackets&&tokens[i].kind==='id'&&v==='await'&&tokens[i+1]?.value==='tools'&&tokens[i+2]?.value==='.'&&
       tokens[i+3]?.value==='exec_command'&&tokens[i+4]?.value==='('&&tokens[i+5]?.value==='{'){
      let depth=1;
      for(let j=i+6;j<tokens.length&&depth;j++){
        const item=tokens[j];if(item.kind==='punct'&&item.value==='{'){depth++;continue;}if(item.kind==='punct'&&item.value==='}'){depth--;continue;}
        if(depth===1&&item.value==='cmd'&&tokens[j+1]?.value===':'&&tokens[j+2]?.kind==='string')result.push(tokens[j+2].value);
      }
    }
    if(tokens[i].kind==='punct'){
      if(v==='{')braces++;else if(v==='}')braces--;else if(v==='(')parens++;else if(v===')')parens--;else if(v==='[')brackets++;else if(v===']')brackets--;
    }
    if(braces<0||parens<0||brackets<0)return [];
  }
  return braces||parens||brackets?[]:result;
}
function callCommands(payload){
  if(payload.type==='custom_tool_call')return wrapperCommands(payload.input);
  if(payload.type==='function_call'&&payload.name==='exec_command'){
    try{const args=JSON.parse(payload.arguments||'{}'),value=args.cmd??args.command;return [Array.isArray(value)?value.at(-1):value].filter(item=>typeof item==='string');}catch{}
  }
  return [];
}
function continuation(output,tool){
  // Only the outer tool's first status block is trusted as cell metadata. A test's stdout can itself say
  // 'session id: 123' or 'Script running...' and must not create a fictitious running process.
  const first=Array.isArray(output)?output[0]:output;
  const text=typeof first==='string'?first:typeof first?.text==='string'?first.text:'';
  const blocks=Array.isArray(output)?output:[output];
  const hasDenial=blocks.some(block=>/Auto-review denied|rejected due to unacceptable risk/i.test(typeof block==='string'?block:String(block?.text||'')));
  if(hasDenial)return {kind:'denied'};
  const cell=/^Script running with cell ID\s+([A-Za-z0-9_:-]+)(?:\s|$)/.exec(text);
  if(cell&&tool!=='direct')return {kind:'cell',id:cell[1]};
  if(tool==='direct'){
    let value=output&&typeof output==='object'&&!Array.isArray(output)&&Object.hasOwn(output,'session_id')?output:null;
    if(!value&&text){try{value=JSON.parse(text);}catch{}}
    if(value&&Number.isInteger(value.session_id)&&value.exit_code==null&&
       Object.keys(value).every(key=>['session_id','exit_code','output','wall_time_seconds','chunk_id','original_token_count'].includes(key)))
      return {kind:'session',id:String(value.session_id)};
  }
  return {kind:'ended',hasAdditionalOutput:Array.isArray(output)&&output.slice(1).some(block=>typeof block?.text==='string'&&block.text.trim())};
}
function waitTarget(payload){
  let text=typeof payload.input==='string'?payload.input:'';
  if(typeof payload.arguments==='string')text+='\n'+payload.arguments;
  const cell=/(?:cell_id|cellId)["']?\s*[:=]\s*["']([A-Za-z0-9_:-]+)["']/.exec(text);
  if(cell&&/\bwait\b|tools\.wait/.test((payload.name||'')+' '+text))return {kind:'cell',id:cell[1]};
  const session=/(?:session_id|sessionId)["']?\s*[:=]\s*["']?(\d+)/.exec(text);
  if(session&&/write_stdin/.test((payload.name||'')+' '+text))return {kind:'session',id:session[1]};
  return null;
}
function finish(state,key){
  const pending=state.pending?.parallelTestReview?.tests||[];
  if(state.clockAnnounced?.['parallel_test:'+key]||pending.some(item=>item.source?.callId===key))
    (state.parallelTestFinished||={})[key]=true;
  else if(state.parallelTestSourceUncertain)delete state.parallelTestSourceUncertain[key];
  delete state.parallelTestCalls?.[key];
}
function markSourceUncertain(state,file){
  if(!file)return;
  const calls=Object.entries(state.parallelTestCalls||{}).filter(([,item])=>item.source?.path===file).map(([id])=>id);
  const pending=(state.pending?.parallelTestReview?.tests||[]).filter(item=>item.source?.path===file).map(item=>item.source?.callId).filter(Boolean);
  for(const id of new Set([...calls,...pending])){
    (state.parallelTestSourceUncertain||={})[id]=true;
    if(state.parallelTestFinished)delete state.parallelTestFinished[id];
  }
}
function track(state,row,commands,source,boundAt=0){
  const payload=row.payload||{},at=row.timestamp,atMs=Date.parse(at),id=payload.call_id;
  const calls=state.parallelTestCalls||={};
  if(row.type==='event_msg'&&['item_started','item_completed'].includes(payload.type)&&payload.item?.type==='CommandExecution'){
    const item=payload.item,processId=String(item.process_id||item.id||'');
    const map=state.parallelTestProcesses||={};
    if(payload.type==='item_started'){
      const command=Array.isArray(item.command)?item.command.at(-1):item.command;
      if(typeof command==='string'&&recognizable(command)){
        const digest='sha256:'+hash(command),ids=Object.keys(calls).filter(key=>(calls[key].commandHashes||[calls[key].commandHash]).includes(digest));
        const mapped=new Set(Object.values(map).flat()),unmapped=ids.filter(key=>!mapped.has(key));
        if(unmapped.length===1&&processId){map[processId]=unmapped;calls[unmapped[0]].status='running';}
        else if(!unmapped.length&&ids.length&&processId){
          // A second identical process might belong to the same tool call: attribution is no longer unique.
          for(const key of ids)calls[key].status='unknown';
          for(const proc of Object.keys(map))if(map[proc].some(key=>ids.includes(key)))delete map[proc];
        }
      }
    }else if(processId&&map[processId]){for(const key of map[processId])finish(state,key);delete map[processId];}
    return;
  }
  if(row.type!=='response_item'||!id)return;
  if(['custom_tool_call','function_call'].includes(payload.type)){
    const target=waitTarget(payload);
    if(target){const ids=Object.keys(calls).filter(key=>calls[key].continuation?.kind===target.kind&&calls[key].continuation?.id===target.id);
      if(ids.length)(state.parallelTestWaits||={})[id]=ids;}
    if(!Number.isFinite(atMs)||atMs<boundAt||!source?.path||!Number.isInteger(source.offset))return;
    const selected=callCommands(payload).filter(recognizable);if(!selected.length)return;
    calls[id]={source:{path:source.path,offset:source.offset,callId:id},startedAt:at,commandHash:'sha256:'+hash(selected.join('\n')),
      commandHashes:selected.map(command=>'sha256:'+hash(command)),
      tool:payload.type==='function_call'&&payload.name==='exec_command'?'direct':'wrapper',status:'pending'};
  }else if(['custom_tool_call_output','function_call_output'].includes(payload.type)){
    const ids=[...(calls[id]?[id]:[]),...((state.parallelTestWaits||{})[id]||[])];
    const waited=new Set((state.parallelTestWaits||{})[id]||[]);
    for(const key of ids){const item=calls[key];if(!item)continue;
      const result=continuation(payload.output,item.tool);
      if(result.kind==='denied')finish(state,key);
      else if(result.kind==='ended'&&result.hasAdditionalOutput&&waited.has(key)&&item.continuation?.kind==='cell'){
        // The JS cell has ended, but its nested test may have returned a session using unstructured text.
        // Never parse that stdout as a process ID; make one explicitly unknown follow-up possible instead.
        item.status='unknown';item.terminalUnknown=true;delete item.continuation;
      }
      else if(result.kind==='ended')finish(state,key);
      else{item.continuation=result;item.status=item.status==='running'?'running':'unknown';}}
    if(state.parallelTestWaits)delete state.parallelTestWaits[id];
  }
}
function observedAgents(binding,state){
  try{
    const pace=require('./pace.cjs');fs.accessSync(pace.sessionsRoot(),fs.constants.R_OK);
    const source=pace.sessionFile(binding.executorId)||state.executorLog;if(!source)throw Error('missing executor source');
    fs.accessSync(source,fs.constants.R_OK);return pace.agentRuns(binding);
  }catch{return null;}
}
function fingerprint(snapshot,agents){
  // A changed record requires human rechecking, but neither transcript nor snapshot proves live platform status.
  let active=null;
  if(Array.isArray(agents)){
    const latest=new Map();for(const item of agents){const id=item.path||item.id;
      if(id&&(!latest.has(id)||(item.lastAt||0)>(latest.get(id).lastAt||0)))latest.set(id,item);}
    active=[...latest.entries()].filter(([,item])=>item.active).map(([id])=>id).sort();
  }
  const canonical=value=>Array.isArray(value)?value.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):
    value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const select=(list,keys)=>Array.isArray(list)?list.map(item=>Object.fromEntries(keys.map(key=>[key,item?.[key]??null])))
    .map(canonical).sort((a,b)=>String(a.id).localeCompare(String(b.id))):null;
  const capacity=Number.isInteger(snapshot?.capacity?.verified)?snapshot.capacity.verified:null;
  const flight=select(snapshot?.packages?.inFlight,['id','handle','exclusiveResources']);
  const ready=select(snapshot?.packages?.ready,['id','dependencies','independent','safe','exclusiveResources']);
  return 'sha256:'+hash(JSON.stringify({active,capacity,flight,ready}));
}
function leads(state,once){
  const result=[];
  for(const [key,item] of Object.entries(state.parallelTestCalls||{})){
    if(item.status==='pending')continue;
    const fresh=once('parallel_test:'+item.source.callId);
    if(fresh){
      const {source,startedAt,commandHash}=item,status=state.parallelTestSourceUncertain?.[key]?'unknown':item.status;
      result.push({source,startedAt,commandHash,status});
    }
    // Keep it through the pending event's decision preflight; an already-reviewed terminal unknown can then go.
    if(item.terminalUnknown&&!fresh)delete state.parallelTestCalls[key];
  }
  return result;
}
// Recheck before applying a decision. Missing sources are unknown, never silently treated as completed.
// A changed result must be reissued under a new event ID; the old event and submitted decision stay immutable.
function reassess(event,state,snapshot,agents,{readable=true}={}){
  if(!event.reasons?.includes('parallel_test_review'))return {changed:false};
  if(!Array.isArray(event.parallelTestReview?.tests)||!event.parallelTestReview.tests.length){
    // Missing evidence is unknown, not an obsolete event. Reissue it once with the explicit unknown marker;
    // after that the supervisor can investigate it without an infinite reissue loop.
    return {changed:event.parallelTestReview?.sourceCoverage!=='unknown',reasons:event.reasons,tests:[],
      fingerprint:null,missingDetails:true};
  }
  let changed=false;
  const tests=[];let uncertain=false;
  for(const test of event.parallelTestReview?.tests||[]){
    const id=test.source?.callId,item=readable?state.parallelTestCalls?.[id]:null;
    const sourceUnknown=!readable||Boolean(state.parallelTestSourceUncertain?.[id]);
    if(sourceUnknown)uncertain=true;
    if(!sourceUnknown&&state.parallelTestFinished?.[id]){changed=true;continue;}
    const status=!sourceUnknown&&item?.status==='running'?'running':'unknown';
    if(status!==test.status)changed=true;
    tests.push({...test,status});
  }
  const reasons=tests.length?event.reasons:event.reasons.filter(reason=>reason!=='parallel_test_review');
  if(!tests.length&&event.reasons.includes('parallel_test_review'))changed=true;
  const currentFingerprint=uncertain?null:fingerprint(snapshot,agents);
  if(event.parallelTestReview?.fingerprint!==currentFingerprint)changed=true;
  return {changed,reasons,tests,fingerprint:currentFingerprint};
}
function clear(state,event,{retain=[]}={}){
  const keep=new Set(retain);
  for(const test of event.parallelTestReview?.tests||[]){const id=test.source?.callId;if(!id)continue;
    if(keep.has(id))continue;
    if(state.parallelTestFinished)delete state.parallelTestFinished[id];
    if(state.parallelTestSourceUncertain)delete state.parallelTestSourceUncertain[id];
    if(state.parallelTestCalls?.[id]?.terminalUnknown)delete state.parallelTestCalls[id];}
}
module.exports={segments,gateCommand,recognizable,jsTokens,wrapperCommands,callCommands,continuation,waitTarget,track,observedAgents,fingerprint,leads,reassess,clear,markSourceUncertain};
