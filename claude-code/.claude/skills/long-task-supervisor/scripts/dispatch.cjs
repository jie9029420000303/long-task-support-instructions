#!/usr/bin/env node
const fs=require('node:fs');
const path=require('node:path');
const {parse}=require('./dispatch-audit.cjs');
const [command,runArg,inputArg]=process.argv.slice(2);
try{
  if(command!=='write'||!path.isAbsolute(runArg||'')||!path.isAbsolute(inputArg||''))throw Error('Usage: dispatch.cjs write ABSOLUTE_RUN ABSOLUTE_INPUT_JSON');
  const run=path.resolve(runArg),binding=JSON.parse(fs.readFileSync(path.join(run,'binding.json'),'utf8'));
  if(!binding.dispatchAudit?.enabled&&!fs.existsSync(path.join(run,'DISPATCH_AUDIT')))throw Error('Dispatch auditing is not attached to this run');
  const value=parse(JSON.parse(fs.readFileSync(inputArg,'utf8')),binding);
  const output=path.join(run,binding.dispatchAudit?.snapshot||'dispatch.json'),temporary=output+'.tmp-'+process.pid;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  fs.renameSync(temporary,output);
  console.log(JSON.stringify({written:true,path:output,planningRevision:value.planningRevision}));
}catch(error){console.error(error.message);process.exitCode=1;}
