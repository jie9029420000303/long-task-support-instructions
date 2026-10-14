// Claude Desktop signals the supervisor's clock reads from transcripts: platform error turns (rate limits among
// them), auto-mode refusals, polling turns and the executor's model, effort and permission mode. Each was confirmed
// in real transcripts on 2026-10-12 and 2026-10-14.
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const textOf=row=>(row?.message?.content||[]).filter(block=>block?.type==='text').map(block=>block.text).join('\n');
// Minutes east of UTC for a time zone at one instant.
function offsetMinutes(zone,ms){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'})
    .formatToParts(new Date(ms)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  return Math.round((Date.UTC(parts.year,parts.month-1,parts.day,parts.hour%24,parts.minute,parts.second)-ms)/60000);
}
// "You've hit your session limit · resets 3:40am (Asia/Taipei)", "resets 8pm (Asia/Taipei)" or the weekly
// "resets Oct 5 at 8pm (Asia/Taipei)" (6 of the 7 rate-limit rows of 2026-09-23..10-14): the first matching wall time
// after the notice. A notice naming no time (a spend limit, "Server is temporarily limiting requests") has no reset.
function resetAfter(text,at){
  const match=/resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text||'');
  if(match){
    const [,mon,day,hour,minute,half,zone]=match;
    let h=Number(hour)%12+(half.toLowerCase()==='pm'?12:0);const m=Number(minute||0);
    try{
      for(let d=0;d<=8;d++){
        const probe=at+d*86400000,offset=offsetMinutes(zone,probe),local=new Date(probe+offset*60000);
        if(mon&&(MONTHS.indexOf(mon.toLowerCase())!==local.getUTCMonth()||Number(day)!==local.getUTCDate()))continue;
        const wall=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),h,m);
        const until=wall-offsetMinutes(zone,wall-offset*60000)*60000;
        if(until>at)return {until,basis:'限速訊息的重置時間（'+zone+'）'};
      }
    }catch{}
  }
  return null;
}
// A platform error turn: once Claude's own retries (system api_error rows) run out, it ends the turn with a synthetic
// assistant row (isApiErrorMessage, model <synthetic>, stop_sequence, not end_turn), so without this the executor
// only looks silent. 2026-09-23..10-14, 55 rows: authentication_failed 34, server_error 11, rate_limit 7, unknown 3.
function platformErrorOf(row){
  if(row?.type!=='assistant'||!row.isApiErrorMessage)return null;
  const at=Date.parse(row.timestamp)||Date.now(),text=textOf(row).slice(0,300);
  const reset=row.error==='rate_limit'?resetAfter(text,at):null;
  return {since:at,kind:row.error||'unknown',status:row.apiErrorStatus??null,text,...(reset||{})};
}
// A rate limit that names its reset is a known wait (Jay 2026-10-13: no model or account switch, wait for the reset).
function rateLimitOf(row){const error=platformErrorOf(row);return error?.until?error:null;}
// Polling a background job or sleeping is not work: a main line that only polls one background job is idle.
const POLL_TOOLS=new Set(['TaskOutput','BashOutput']);
function pollOnly(block){
  if(block?.type!=='tool_use')return false;
  if(POLL_TOOLS.has(block.name))return true;
  return block.name==='Bash'&&typeof block.input?.command==='string'&&/^\s*sleep\s+\d+(?:\.\d+)?\s*;?\s*$/.test(block.input.command);
}
// What a call works on, for telling a newly blocked item from another refusal of the same one: the first program and
// its subcommand (cd/export prefixes skipped), or the tool name when the call runs no shell command.
function workItem(block){
  const command=typeof block?.input?.command==='string'?block.input.command:'';
  for(const part of command.split(/&&|\|\||;|\|/)){
    const words=part.trim().split(/\s+/).filter(word=>word&&!/^-/.test(word)&&!/^[A-Z_]+=/.test(word));
    if(!words.length||['cd','export','set','source','.'].includes(words[0]))continue;
    return words.slice(0,2).map(word=>word.split('/').pop()).join(' ').slice(0,60);
  }
  return block?.name||'unknown';
}
// The auto-mode classifier's refusal (82 rows). "auto mode cannot determine the safety ... temporarily unavailable"
// is a transient outage, not a refusal.
const AUTO_DENIAL=/denied by the Claude Code auto mode classifier/i;
function refusalOf(block){
  if(block?.type!=='tool_result'||!block.is_error)return null;
  const content=typeof block.content==='string'?block.content:JSON.stringify(block.content||'');
  if(!AUTO_DENIAL.test(content))return null;
  return (/Reason:\s*([^\n]{0,300})/.exec(content)?.[1]||content.slice(0,300)).trim();
}
const isOpus=model=>/claude-opus/i.test(model||'');
module.exports={offsetMinutes,resetAfter,platformErrorOf,rateLimitOf,pollOnly,workItem,refusalOf,isOpus,textOf};
