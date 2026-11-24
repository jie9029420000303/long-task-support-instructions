#!/usr/bin/env node
// 送審 in one step (Jay 2026-11-23「2A」): write the manifest, register its version on the submitted packages through
// dispatch.cjs submit (same lock and checks as every dispatch write), and print the submission event only when that
// worked. Before, registering was a second step written only in execution.md: of 85 rulings on 2026-11-21..23, 25 met
// a submission no package carried, and the supervisor's package rulings were refused without saying why.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const { hash, need } = require('./guard.cjs');
const USAGE='Usage: candidate.cjs ABSOLUTE_RUN ABSOLUTE_STATE_DIR PACKAGE_ID[,PACKAGE_ID...] ABSOLUTE_MANIFEST ABSOLUTE_FILE [ABSOLUTE_FILE ...]';
let created=null;
try {
  const [run,stateDir,ids,manifest,...files]=process.argv.slice(2);
  need([run,stateDir,manifest].every(value=>path.isAbsolute(value||''))&&ids&&files.length>0,USAGE+
    '。送審要寫明這一版屬於哪些工作包（PACKAGE_ID，多個用逗號分隔），工具會把版本登記到這些工作包，監督才能逐包裁決');
  need(!fs.existsSync(manifest),'Use a new manifest path for each submission');
  const listed=[];
  for (const file of files) {
    need(path.isAbsolute(file) && fs.statSync(file,{throwIfNoEntry:false})?.isFile(),'Candidate must be an existing absolute file: '+file);
    need(!listed.some(row=>row.path===file),'Duplicate candidate file');
    listed.push({path:file,sha256:hash(file)});
  }
  fs.writeFileSync(manifest,JSON.stringify({files:listed},null,2)+'\n',{flag:'wx'});created=manifest;
  let out;
  try{out=execFileSync(process.execPath,[path.join(__dirname,'dispatch.cjs'),'submit',run,stateDir,manifest,...ids.split(',').map(id=>id.trim()).filter(Boolean)],
    {encoding:'utf8',stdio:['ignore','pipe','pipe']});}
  catch(error){throw Error('沒有送出送審事件：版本登記到工作包失敗（'+String(error.stderr||error.message).trim()+'）。照訊息修正後用新的清單路徑重送；這次的清單已刪除');}
  created=null;
  console.log(JSON.parse(out.trim().split('\n').at(-1)).event);
} catch (error) {
  if(created)fs.rmSync(created,{force:true});
  console.error(error.message);process.exitCode=1;
}
