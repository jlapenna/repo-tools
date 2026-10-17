// Required verify consumer: creation-age retirement must preserve real dirty
// Git/file state and refuse unknown age, occupied or changing snapshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,unlinkSync,symlinkSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'created-worktree-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const primary=join(root,'primary'),path=join(root,'checkout'),bins=join(root,'bin');
  mkdirSync(primary);mkdirSync(bins);
  const env={...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',CREATED_TEST_BIRTH:String(Math.floor(Date.now()/1000)-73*3600)};
  const run=(command,args,extra={})=>spawnSync(command,args,{cwd:root,env,encoding:'utf8',...extra});
  const git=(...args)=>{
    const r=run('git',['-C',primary,'-c','user.name=Test','-c','user.email=test@example.invalid',...args]);
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  git('init','-q','-b','main');
  writeFileSync(join(primary,'.gitignore'),'.env\nlocal-state/\nnode_modules/\n');
  for(const name of ['mixed','staged-delete','unstaged-delete'])writeFileSync(join(primary,name),'base\n');
  git('add','.');git('commit','-qm','base');
  git('worktree','add','-qb','feature',path);
  const realStat=run('which',['stat']).stdout.trim();
  // Positive-age fixtures mock ONLY the synthetic Git-link birth query.
  // A separate negative control below uses the real, freshly-created link.
  writeFileSync(join(bins,'stat'),`#!/bin/sh
if [ "$*" = "-c %W -- ${path}/.git" ]; then
  case "$CREATED_TEST_AGE" in fresh) exec '${realStat}' "$@";; unknown) echo 0;; *) printf '%s\\n' "$CREATED_TEST_BIRTH";; esac
else exec '${realStat}' "$@"; fi
`,{mode:0o700});
  writeFileSync(join(bins,'gh'),'#!/bin/sh\nexit 199\n',{mode:0o700});
  env.PATH=bins+':'+env.PATH;
  const prune=(...args)=>run('bash',[join(here,'prune-merged-worktrees.sh'),'--repo',primary,'--retire-created-hours','72',...args,path]);
  const archives=()=>existsSync(join(primary,'.git','parked-worktrees'))?readdirSync(join(primary,'.git','parked-worktrees')).map(n=>join(primary,'.git','parked-worktrees',n)):[];
  const semantic=()=>['ls-files --stage -z','diff --cached --binary','diff --binary','status --porcelain=v1 --untracked-files=all -z'].map(s=>git('-C',path,...s.split(' ')));
  return {root,primary,path,env,run,git,prune,archives,semantic};
}

test('creation-age mode is explicit, has no audit side effects, and rejects fresh/unknown birth evidence',t=>{
  const f=fixture(t);
  for(const age of ['fresh','unknown']) {
    f.env.CREATED_TEST_AGE=age;
    const r=f.prune('--delete');assert.equal(r.status,1,r.stderr+r.stdout);
    assert.match(r.stdout,/KEEP.*creation-age/);assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
  }
  delete f.env.CREATED_TEST_AGE;
  const report=f.prune();assert.equal(report.status,0,report.stderr);
  assert.match(report.stdout,/SAFE.*parkable:created-age/);assert.deepEqual(f.archives(),[]);
  assert.equal(f.prune('--park-inactive','--idle-hours','72').status,2);
});

test('dirty index and working files round-trip after GC, without resurrecting tracked deletions',t=>{
  const f=fixture(t);
  writeFileSync(join(f.path,'mixed'),'staged\n');f.git('-C',f.path,'add','mixed');writeFileSync(join(f.path,'mixed'),'working\n');
  f.git('-C',f.path,'rm','-q','staged-delete');unlinkSync(join(f.path,'unstaged-delete'));
  writeFileSync(join(f.path,'staged-only'),'only staged object\n');f.git('-C',f.path,'add','staged-only');unlinkSync(join(f.path,'staged-only'));
  writeFileSync(join(f.path,'untracked'),Buffer.from([0,1,255]));writeFileSync(join(f.path,'.env'),'FAKE_LOCAL_INPUT=kept\n',{mode:0o600});
  mkdirSync(join(f.path,'node_modules'));writeFileSync(join(f.path,'node_modules','cache'),'reinstall');
  symlinkSync('mixed',join(f.path,'link'));
  const before=f.semantic();const index=f.git('-C',f.path,'rev-parse','--path-format=absolute','--git-path','index');const original=readFileSync(index);
  const r=f.prune('--delete');assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/PARKED/);assert.equal(existsSync(f.path),false);
  const [archive]=f.archives();const m=JSON.parse(readFileSync(join(archive,'manifest.json')));
  assert.equal(m.version,2);assert.equal(f.git('rev-parse',m.ref),m.source.head);assert.equal(f.git('rev-parse',m.index_ref),m.index_tree);
  assert.deepEqual(readFileSync(join(archive,'index')),original);
  f.git('gc','--prune=now');
  const restored=f.run('bash',[join(here,'restore-worktree.sh'),archive]);assert.equal(restored.status,0,restored.stderr);
  assert.deepEqual(f.semantic(),before);assert.equal(readFileSync(join(f.path,'.env'),'utf8'),'FAKE_LOCAL_INPUT=kept\n');
  assert.deepEqual(readFileSync(join(f.path,'untracked')),Buffer.from([0,1,255]));assert.equal(existsSync(join(f.path,'node_modules')),false);
  for(const name of ['staged-delete','unstaged-delete','staged-only'])assert.equal(existsSync(join(f.path,name)),false);
});

test('split index, unmerged operations, Git locks and foreign live sessions stay',async t=>{
  for(const kind of ['split','operation','locked','live']) {
    const f=fixture(t);let child;
    if(kind==='split')f.git('-C',f.path,'update-index','--split-index');
    if(kind==='operation')writeFileSync(f.git('-C',f.path,'rev-parse','--path-format=absolute','--git-path','MERGE_HEAD'),f.git('rev-parse','HEAD')+'\n');
    if(kind==='locked')f.git('worktree','lock',f.path);
    if(kind==='live') {child=spawn('sleep',['120'],{cwd:f.path,detached:true,stdio:'ignore'});await new Promise(resolve=>child.once('spawn',resolve));t.after(()=>child.kill());}
    const r=f.prune('--delete');assert.equal(r.status,1,r.stderr+r.stdout);assert.match(r.stdout,/KEEP/);assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
    if(child){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
  }
});

test('consumer lock rejects added ignored files and staging-only changes',t=>{
  for(const kind of ['ignored','index']) {
    const f=fixture(t);writeFileSync(join(f.path,'mixed'),'dirty working\n');mkdirSync(join(f.path,'local-state'));
    const hook=join(f.root,'hook');
    const mutation=kind==='ignored'?'printf new > "$1/local-state/new-private"':'printf staged > "$1/late"; git -C "$1" add late; rm "$1/late"';
    writeFileSync(hook,'#!/bin/bash\nset -euo pipefail\nexec 9>"$1.lock"\nflock 9\n'+mutation+'\n"$2" "$1"\n',{mode:0o700});
    const r=f.prune('--delete','--remove-hook',hook);assert.equal(r.status,1,r.stderr+r.stdout);assert.match(r.stdout,/KEEP/);assert.equal(existsSync(f.path),true);
    // Changed snapshots retain their original recovery evidence as well.
    assert.equal(f.archives().length,1);
  }
});

test('actual high-level cleanup accepts its own parent cwd after the tool moves outside',t=>{
  for(const mode of ['created','merged']) {
    const f=fixture(t);
    if(mode==='merged')writeFileSync(join(f.root,'bin','gh'),'#!/bin/sh\nprintf "[[]]\\n"\n',{mode:0o700});
    const actor=`import subprocess,sys,json
subject,primary,target,outside,mode=sys.argv[1:]
args=['bash',subject,'--repo',primary,'--delete']
args+=['--retire-created-hours','72'] if mode=='created' else ['--base','main']
r=subprocess.run(args+[target],cwd=outside,capture_output=True,text=True)
print(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr}))
`;
    const result=f.run('python3',['-c',actor,join(here,'prune-merged-worktrees.sh'),f.primary,f.path,f.root,mode],{cwd:f.path});
    assert.equal(result.status,0,result.stderr);
    const r=JSON.parse(result.stdout);assert.equal(r.rc,0,r.stderr+r.stdout);
    assert.match(r.stdout,mode==='created'?/PARKED/:/REMOVED/);assert.equal(existsSync(f.path),false);
  }
});

test('an unavailable process scanner is KEEP before any snapshot or removal',t=>{
  const f=fixture(t),commands=join(f.root,'commands');
  cpSync(here,commands,{recursive:true});
  writeFileSync(join(commands,'scan-live-processes.sh'),'#!/bin/sh\nexit 75\n',{mode:0o700});
  const r=f.run('bash',[join(commands,'prune-merged-worktrees.sh'),'--repo',f.primary,'--retire-created-hours','72','--delete',f.path]);
  assert.equal(r.status,1,r.stderr+r.stdout);assert.match(r.stdout,/KEEP.*occupancy-unverifiable/);
  assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
});

test('a nested independent primary remains intact even inside an ignored directory',t=>{
  const f=fixture(t),nested=join(f.path,'local-state','separate-primary');
  mkdirSync(nested,{recursive:true});f.git('-C',nested,'init','-q','-b','main');
  writeFileSync(join(nested,'private-work'),'nested owner work\n');
  const r=f.prune('--delete');assert.equal(r.status,1,r.stderr+r.stdout);
  assert.match(r.stdout,/KEEP.*nested-independent-git-checkout/);
  assert.equal(readFileSync(join(nested,'private-work'),'utf8'),'nested owner work\n');
  assert.equal(existsSync(join(nested,'.git')),true);assert.deepEqual(f.archives(),[]);
});

test('worktree-only configuration and full-index sparse checkout are retained before capture',t=>{
  for(const kind of ['config','sparse']) {
    const f=fixture(t);
    if(kind==='config') {
      f.git('config','extensions.worktreeConfig','true');
      f.git('-C',f.path,'config','--worktree','core.fileMode','false');
    } else {
      f.git('-C',f.path,'sparse-checkout','init','--no-sparse-index','--no-cone');
      f.git('-C',f.path,'sparse-checkout','set','--no-cone','/mixed');
      assert.doesNotMatch(f.git('-C',f.path,'ls-files','--sparse','--stage'),/^040000/m);
      assert.match(f.git('-C',f.path,'ls-files','-t'),/^S /m);
    }
    const r=f.prune('--delete');assert.equal(r.status,1,r.stderr+r.stdout);
    assert.match(r.stdout,kind==='config'?/KEEP.*worktree-config-needs-independent-recovery/:/KEEP.*sparse-checkout-needs-independent-recovery/);
    assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
  }
});

test('dangling sparse metadata is retained rather than silently lost',t=>{
  const f=fixture(t),sparse=f.git('-C',f.path,'rev-parse','--path-format=absolute','--git-path','info/sparse-checkout');
  mkdirSync(dirname(sparse),{recursive:true});symlinkSync('missing-private-patterns',sparse);
  const r=f.prune('--delete');assert.equal(r.status,1,r.stderr+r.stdout);
  assert.match(r.stdout,/KEEP.*sparse-checkout-needs-independent-recovery/);
  assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
});

test('identity-only worktree configuration survives private retirement and restoration',t=>{
  const f=fixture(t);
  f.git('config','extensions.worktreeConfig','true');
  f.git('-C',f.path,'config','--worktree','user.name','First identity');
  f.git('-C',f.path,'config','--worktree','--add','user.name','Last "quoted" identity\nsecond line');
  f.git('-C',f.path,'config','--worktree','user.email','local@example.invalid');
  const config=f.git('-C',f.path,'rev-parse','--path-format=absolute','--git-path','config.worktree');
  const mode=f.run('chmod',['0664',config]);assert.equal(mode.status,0,mode.stderr);
  const original=readFileSync(config);
  writeFileSync(join(f.path,'mixed'),'staged identity work\n');f.git('-C',f.path,'add','mixed');
  writeFileSync(join(f.path,'mixed'),'unstaged identity work\n');
  const before=f.semantic();
  const r=f.prune('--delete');assert.equal(r.status,0,r.stderr+r.stdout);
  assert.equal(existsSync(f.path),false);
  const [archive]=f.archives();const m=JSON.parse(readFileSync(join(archive,'manifest.json')));
  assert.equal(m.version,3);assert.equal(m.source.worktree_config.mode,0o664);assert.deepEqual(readFileSync(join(archive,'config.worktree')),original);
  f.git('gc','--prune=now');
  const restored=f.run('bash',[join(here,'restore-worktree.sh'),archive]);assert.equal(restored.status,0,restored.stderr);
  const newConfig=f.git('-C',f.path,'rev-parse','--path-format=absolute','--git-path','config.worktree');
  assert.equal(f.run('stat',['-c','%a',newConfig]).stdout.trim(),'664');
  assert.deepEqual(readFileSync(newConfig),original);assert.deepEqual(f.semantic(),before);
  const identity=f.run('git',['-C',f.path,'config','--get','user.name']);
  assert.equal(identity.status,0);assert.equal(identity.stdout,'Last "quoted" identity\nsecond line\n');
  // Same UID with a changed primary group must fail before creating a checkout.
  const manifest=join(archive,'manifest.json');const saved=readFileSync(manifest);
  m.source.worktree_config.group_write_gid=process.getgid()+1;
  writeFileSync(manifest,JSON.stringify(m));
  const alternate=join(f.root,'changed-primary-group');
  const refused=f.run('bash',[join(here,'restore-worktree.sh'),archive,'--path',alternate]);
  assert.equal(refused.status,75,refused.stderr);assert.equal(existsSync(alternate),false);
  assert.match(refused.stderr,/primary-group-changed/);writeFileSync(manifest,saved);

});

test('identity configuration changes and changed extension semantics retain the checkout',t=>{
  for(const kind of ['identity','extension']) {
    const f=fixture(t);f.git('config','extensions.worktreeConfig','true');
    f.git('-C',f.path,'config','--worktree','user.name','Before snapshot');
    const hook=join(f.root,'config-hook');
    const mutation=kind==='identity'?'git -C "$1" config --worktree user.name "After snapshot"':'git -C "$1" config --local extensions.worktreeConfig false';
    writeFileSync(hook,'#!/bin/bash\nset -euo pipefail\nexec 9>"$1.lock"\nflock 9\n'+mutation+'\n"$2" "$1"\n',{mode:0o700});
    const r=f.prune('--delete','--remove-hook',hook);assert.equal(r.status,1,r.stderr+r.stdout);
    assert.match(r.stdout,/KEEP/);assert.equal(existsSync(f.path),true);assert.equal(f.archives().length,1);
    const [archive]=f.archives();assert.match(readFileSync(join(archive,'config.worktree'),'utf8'),/Before snapshot/);
  }
});

test('identity recovery rejects includes, nonidentity settings and redirected config files',t=>{
  const differentGroup=process.getgroups().find(g=>g!==process.getgid());
  const kinds=['include','nonidentity','symlink','writable'];
  if(differentGroup!==undefined)kinds.push('different-group');
  for(const kind of kinds) {
    const f=fixture(t);f.git('config','extensions.worktreeConfig','true');
    f.git('-C',f.path,'config','--worktree','user.name','Safe identity');
    const config=f.git('-C',f.path,'rev-parse','--path-format=absolute','--git-path','config.worktree');
    if(kind==='include')f.git('-C',f.path,'config','--worktree','include.path','/missing');
    if(kind==='nonidentity')f.git('-C',f.path,'config','--worktree','core.hooksPath','/missing');
    if(kind==='symlink') {const copy=join(f.root,'identity-source');writeFileSync(copy,readFileSync(config));unlinkSync(config);symlinkSync(copy,config);}
    if(kind==='writable') {const changed=f.run('chmod',['0666',config]);assert.equal(changed.status,0,changed.stderr);}
    if(kind==='different-group') {
      const changed=f.run('chgrp',[String(differentGroup),config]);assert.equal(changed.status,0,changed.stderr);
      const mode=f.run('chmod',['0664',config]);assert.equal(mode.status,0,mode.stderr);
    }
    const r=f.prune('--delete');assert.equal(r.status,1,r.stderr+r.stdout);
    assert.match(r.stdout,/KEEP/);assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
  }
});
