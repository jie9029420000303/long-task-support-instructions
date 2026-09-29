#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { hash, need } = require('./guard.cjs');
try {
  const [manifest,...files]=process.argv.slice(2);
  need(manifest && path.isAbsolute(manifest) && files.length>0,'Use an absolute manifest path and at least one absolute candidate file');
  need(!fs.existsSync(manifest),'Use a new manifest path for each submission');
  const listed=[];
  for (const file of files) {
    need(path.isAbsolute(file) && fs.statSync(file).isFile(),'Candidate must be an existing absolute file');
    need(!listed.some(row=>row.path===file),'Duplicate candidate file');
    listed.push({path:file,sha256:hash(file)});
  }
  fs.writeFileSync(manifest,JSON.stringify({files:listed},null,2)+'\n',{flag:'wx'});
  console.log('LONG_TASK_EVENT '+JSON.stringify({kind:'submission',revision:'sha256:'+hash(manifest),manifest}));
} catch (error) {console.error(error.message);process.exitCode=1;}
