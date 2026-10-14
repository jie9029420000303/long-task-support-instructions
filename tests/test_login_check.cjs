// Logins a long run depends on (Jay 2026-10-14:「先做一次需要權限的掃描，讓我還在電腦前，盡快完成登入並且建立登入有效留存
// 的機制」): checked before Jay is asked anything at start, then hourly by the supervisor's watcher, including identities
// that are not websites. 2026-10-13 GDB: Jay chose "reuse the existing uat2/uat3 logins" on an unchecked premise; a
// read-only use 27 minutes later found both expired and the multi-identity tests waited 7 hours, although the re-login
// then took 3 minutes and no input from Jay.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const roots=['claude-code/.claude','codex/.agents'].map(dir=>path.resolve(__dirname,'..',dir,'skills/long-task-supervisor/scripts'));
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
function withEnv(values,fn){
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  try{return fn();}finally{for(const [key,value] of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
function fixture(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'login-check-'))),flag=name=>path.join(root,name+'.ok');
  // A fake identity works while its flag file exists; its check prints a token-like string that must never be kept.
  const identity=name=>({name,check:`echo SECRET-${name}-TOKEN; test -f '${flag(name)}'`,login:`重登 ${name}`});
  const landing=path.join(root,'landing'),relay=path.join(root,'relay');
  fs.writeFileSync(relay,'#!/bin/sh\ncase "$1" in navigate) echo "Opened tab 4242";; get) if [ "$2" = url ]; then cat '+landing+'; else echo Jira; fi;; esac\n',{mode:0o755});
  return {root,flag,identity,landing,relay,
    valid(name,on=true){if(on)fs.writeFileSync(flag(name),'');else fs.rmSync(flag(name),{force:true});},
    write(sites,dir=root){save(path.join(dir,'login-sites.json'),{sites});},
    done(){fs.rmSync(root,{recursive:true,force:true});}};
}
const jira={name:'Jira',url:'https://example.atlassian.net/jira',loggedOutPattern:'id\\.atlassian\\.com/login'};
test('both adapters ship the same login check',()=>{
  // Only one adapter changed would let a run moved to the other platform lose its non-browser checks.
  assert.deepEqual(fs.readFileSync(path.join(roots[0],'login-check.cjs')),fs.readFileSync(path.join(roots[1],'login-check.cjs')));
});
for(const scripts of roots){
  const label=scripts.includes('claude-code')?'Claude':'Codex',login=require(path.join(scripts,'login-check.cjs'));
  const cli=(dir,options={})=>spawnSync(process.execPath,[path.join(scripts,'login-check.cjs'),...(dir===undefined?[]:[dir])],{encoding:'utf8',...options});

  test(label+': a non-browser login is checked hourly, reported once per logout, and its output never reaches the run folder',()=>{
    const f=fixture();
    try{
      f.write([f.identity('uat2')]);f.valid('uat2');const state={};
      assert.deepEqual(login.due(state,f.root),[],'working login: nothing to report');
      f.valid('uat2',false);state.lastLoginCheckAt=0;
      const [out]=login.due(state,f.root);
      assert.equal(out.name,'uat2');assert.equal(out.status,'logged_out');assert.equal(out.login,'重登 uat2','the event says how to restore it');
      assert.equal(login.due(state,f.root),null,'once an hour');
      state.lastLoginCheckAt=0;assert.deepEqual(login.due(state,f.root),[],'the same logout is not reported again');
      f.valid('uat2');state.lastLoginCheckAt=0;login.due(state,f.root);
      f.valid('uat2',false);state.lastLoginCheckAt=0;
      assert.deepEqual(login.due(state,f.root).map(item=>item.name),['uat2'],'a new logout after a login is reported again');
      assert.doesNotMatch(fs.readFileSync(path.join(f.root,'login-status.json'),'utf8'),/SECRET-/,'command output is not stored');
    }finally{f.done();}
  });

  test(label+': a broken check is reported as an error, never as a logout',()=>{
    // Exit 0 = works, 1 = lapsed, anything else = the check is broken. Otherwise a missing command or a mistyped MCP
    // server name sends the executor or Jay to log in again while the check is what needs fixing.
    const f=fixture();
    try{
      const bin=path.join(f.root,'bin'),status=path.join(f.root,'mcp-status');fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin,'claude'),'#!/bin/sh\n[ "$1 $2" = "mcp get" ] || exit 3\ncase "$3" in gateway) cat \''+status+'\';; *) echo "No MCP server named $3"; exit 1;; esac\n',{mode:0o755});
      // The documented pattern: a failing CLI exits 3, so only a clear "not connected" answer exits 1.
      const mcp=server=>`out=$(CLAUDE_CONFIG_DIR=$HOME/.gateway-uat-clients/uat2 claude mcp get ${server}) || exit 3; case "$out" in *Connected*) exit 0;; *) exit 1;; esac`;
      f.write([{name:'missing-tool',check:'no-such-login-tool --status'},{name:'crash',check:'exit 2'},{name:'typo',check:mcp('gatewy')},{name:'uat2',check:mcp('gateway')}]);
      withEnv({PATH:bin+path.delimiter+process.env.PATH},()=>{
        fs.writeFileSync(status,'Status: ✓ Connected\n');
        assert.deepEqual(login.checkAll(f.root).map(item=>item.name+':'+item.status),['missing-tool:error','crash:error','typo:error','uat2:logged_in']);
        fs.writeFileSync(status,'Status: ⚠ Needs authentication\n');
        const results=login.checkAll(f.root);
        assert.equal(results.find(item=>item.name==='uat2').status,'logged_out');
        assert.match(results.find(item=>item.name==='missing-tool').detail,/結束碼 127.*不是登入失效/);
      });
    }finally{f.done();}
  });

  test(label+': a broken check that turns into a real logout is reported again',()=>{
    // With one report per name, a chrome-relay outage or a broken check would hide the real logout that follows.
    const f=fixture();
    try{
      const code=path.join(f.root,'code'),next=value=>{fs.writeFileSync(code,String(value));state.lastLoginCheckAt=0;return login.due(state,f.root).map(item=>item.status);};
      f.write([{name:'uat3',check:`exit $(cat '${code}')`}]);const state={};
      assert.deepEqual(next(127),['error']);
      assert.deepEqual(next(127),[],'the same broken check is reported once');
      assert.deepEqual(next(1),['logged_out'],'the logout after it is news');
      assert.deepEqual(next(1),[]);
      assert.deepEqual(next(0),[]);
      assert.deepEqual(next(1),['logged_out'],'a logout after working again is news');
    }finally{f.done();}
  });

  test(label+': a website check that cannot run is reported instead of passing for a working login',()=>{
    // Before, an error was dropped silently: once chrome-relay broke, nothing watched the logins any more.
    const f=fixture();
    try{
      const broken=path.join(f.root,'broken-relay');fs.writeFileSync(broken,'#!/bin/sh\nexit 1\n',{mode:0o755});
      f.write([jira]);
      withEnv({CHROME_RELAY_BIN:broken},()=>{const state={};
        assert.deepEqual(login.due(state,f.root).map(item=>item.status),['error']);
        state.lastLoginCheckAt=0;assert.deepEqual(login.due(state,f.root),[],'reported once until it works again');});
    }finally{f.done();}
  });

  test(label+': the start-time preflight checks every login in the preparation directory at once and lists what needs action',()=>{
    // It runs before init (no run, no watcher state yet) so the first card Jay sees already rests on tested logins.
    const f=fixture();
    try{
      const prep=path.join(f.root,'20261013-v11-claude-準備');fs.mkdirSync(prep);
      fs.writeFileSync(f.landing,'https://id.atlassian.com/login');
      // A project's own settings must not change the answer: checks run in a fixed directory, not the caller's.
      fs.writeFileSync(path.join(prep,'project-only-setting'),'');
      f.write([f.identity('jay'),f.identity('uat2'),{name:'cwd',check:'test ! -e project-only-setting'},{name:'broken',check:'no-such-login-tool'},jira],prep);
      f.valid('jay');
      const out=cli(prep,{cwd:prep,env:{...process.env,CHROME_RELAY_BIN:f.relay}});
      assert.equal(out.status,0,out.stderr);
      const value=JSON.parse(out.stdout);
      assert.equal(value.checked,5);
      assert.deepEqual(value.needsAction.map(item=>item.name+':'+item.status),['uat2:logged_out','broken:error','Jira:logged_out']);
      assert.equal(value.needsAction[0].login,'重登 uat2');
      assert.doesNotMatch(out.stdout+fs.readFileSync(path.join(prep,'login-status.json'),'utf8'),/SECRET-/);
      // On RUN the preflight ignores the hourly gate the watcher just used.
      f.write([f.identity('jay')]);save(path.join(f.root,'daemon-state.json'),{lastLoginCheckAt:Date.now()});
      assert.equal(JSON.parse(cli(f.root).stdout).checked,1);
    }finally{f.done();}
  });

  test(label+': the preflight fails loudly instead of passing when it cannot check',()=>{
    const f=fixture();
    try{
      for(const dir of [undefined,path.join(f.root,'no-such-dir')]){
        const out=cli(dir);
        assert.equal(out.status,2);assert.match(out.stderr,/usage: node login-check\.cjs DIR/);assert.doesNotMatch(out.stderr,/\n\s+at /,'no stack trace');
      }
      // A forgotten list is not "nothing to check"; v117 ran a whole day with no list at all.
      let out=cli(f.root);
      assert.equal(out.status,2);assert.match(out.stderr,/login-sites\.json is missing.*"sites":\[\]/);
      f.write([{name:'uat2'},{name:'Jira',url:'https://example.atlassian.net',loggedOutPattern:'('},f.identity('jay'),f.identity('jay')]);
      out=cli(f.root);
      assert.equal(out.status,2);
      assert.match(out.stderr,/#1 uat2 needs a name and either check/);assert.match(out.stderr,/#2 Jira needs/);assert.match(out.stderr,/jay is listed twice/);
      f.write([]);out=cli(f.root);
      assert.equal(out.status,0);assert.equal(JSON.parse(out.stdout).checked,0);
    }finally{f.done();}
  });

  test(label+': init stores the same list the preflight checked',()=>{
    // init writes RUN/login-sites.json from its input, so a new run never starts without the list (GDB v117 had none).
    const f=fixture();
    try{
      assert.throws(()=>login.write(f.root,[{name:'uat2',check:' '}]),/#1 uat2 needs/);
      assert.equal(fs.existsSync(path.join(f.root,'login-sites.json')),false);
      login.write(f.root,[f.identity('uat2'),jira]);
      assert.deepEqual(login.sites(f.root).map(site=>site.name),['uat2','Jira']);
    }finally{f.done();}
  });
}
