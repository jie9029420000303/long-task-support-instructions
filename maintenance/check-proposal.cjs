#!/usr/bin/env node
// 關卡一 (Jay 2026-11-23「發生問題或進行功能開發時，應該要以最源頭的根本修改，而不是不斷疊加機制」; global rule 2B).
// Every numbered item of a release proposal answers three questions; the third one, what this change replaces or
// removes, may not be blank, and "only an addition" must say why. The release lists how much the skills grew or
// shrank. From v1.0.0 to v1.12.4 (25 releases in 21.5 days) codex/.agents/skills gained 5,262 lines, lost 570 and
// went from 48 to 68 files with none removed, and nothing in the repo asked what a change replaced.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const QUESTIONS=[['origin','事實最早在哪一步產生'],['missed','為什麼沒在那一步被記下或擋下'],['replaces','取代或刪掉哪個既有機制']];
const ONLY_ADDS=/只能新增|沒有取代|不取代|未取代/;
// What install-update.py installs: both platforms' skills plus Claude Code's subagent definitions and workflows.
const SKILLS=['codex/.agents/skills','claude-code/.claude/skills','claude-code/.claude/agents','claude-code/.claude/workflows'];
// One answer per question: the text after "<question>：" up to the next question label or the end of the item.
function answers(body){
  const out={};
  for(const [key,label] of QUESTIONS){
    const at=body.indexOf(label);
    if(at<0){out[key]=null;continue;}
    let rest=body.slice(at+label.length).replace(/^\s*[：:]/,'');
    const next=Math.min(...QUESTIONS.map(([,other])=>rest.indexOf(other)).filter(i=>i>=0),rest.length);
    out[key]=rest.slice(0,next).replace(/\n\s*[-*]\s*$/,'').replace(/^[\s-]+|[\s-]+$/g,'').trim();
  }
  return out;
}
function check(text){
  const items=[...text.matchAll(/^##\s+(\d+)\s+(.+)$/gm)].map((m,i,all)=>({number:Number(m[1]),title:m[2].trim(),
    body:text.slice(m.index+m[0].length,i+1<all.length?all[i+1].index:undefined).split(/^##\s+(?!\d)/m)[0]}));
  if(!items.length)return {ok:false,items:[],problems:['提案沒有編號項目：每項寫成「## <編號> <標題>」，下面回答三題']};
  const problems=[];
  const checked=items.map(item=>{
    const a=answers(item.body),missing=QUESTIONS.filter(([key])=>!a[key]).map(([,label])=>label);
    const own=[];
    if(missing.length)own.push('第 '+item.number+' 項沒回答：'+missing.join('、'));
    // "Only an addition" needs its reason in the same answer, beyond the phrase itself.
    if(a.replaces&&ONLY_ADDS.test(a.replaces)&&a.replaces.replace(ONLY_ADDS,'').replace(/[\s，,。：:；;、]/g,'').length<8)
      own.push('第 '+item.number+' 項只寫了只能新增：寫明為什麼根因修不了、為什麼不能取代既有機制');
    problems.push(...own);
    return {number:item.number,title:item.title,ok:!own.length,onlyAdds:Boolean(a.replaces&&ONLY_ADDS.test(a.replaces)),answers:a};
  });
  return {ok:!problems.length,items:checked,problems};
}
// How much the installed files grew or shrank between two commits (the release lists it).
function growth(repo,base,head='HEAD'){
  const git=args=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'});
  let added=0,removed=0;
  for(const line of git(['diff','--numstat',base,head,'--',...SKILLS]).split('\n').filter(Boolean)){
    const [a,r]=line.split('\t');if(a!=='-'){added+=Number(a);removed+=Number(r);}
  }
  const status=git(['diff','--name-status','--no-renames',base,head,'--',...SKILLS]).split('\n').filter(Boolean).map(line=>line[0]);
  return {base,head,linesAdded:added,linesRemoved:removed,netLines:added-removed,filesAdded:status.filter(s=>s==='A').length,filesRemoved:status.filter(s=>s==='D').length};
}
module.exports={QUESTIONS,check,growth};
if(require.main===module){
  const args=process.argv.slice(2),flag=name=>{const at=args.indexOf('--'+name);return at>=0?args[at+1]:undefined;};
  const file=args[0];
  if(!file||file.startsWith('--')){console.error('Usage: check-proposal.cjs <改版提案.md> [--base <起點 commit 或 tag> [--head <commit>]] [--repo <repo 目錄>]');process.exit(2);}
  const result=check(fs.readFileSync(file,'utf8'));
  if(flag('base'))result.growth=growth(path.resolve(flag('repo')||path.join(__dirname,'..')),flag('base'),flag('head')||'HEAD');
  console.log(JSON.stringify({ok:result.ok,problems:result.problems,items:result.items.map(({number,title,ok,onlyAdds})=>({number,title,ok,onlyAdds})),growth:result.growth},null,2));
  if(!result.ok)process.exitCode=1;
}
