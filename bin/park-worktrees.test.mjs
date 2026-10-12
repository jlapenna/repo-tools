import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url));
function fixture(t,{detached=false,merged=false,oldCommits=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'park-worktree-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const primary=join(root,'primary'),path=join(root,'checkout'),bins=join(root,'bin');
  const env={...process.env,OPEN_PRS_JSON:'[]',MERGED_PRS_JSON:'[]'};
  if(oldCommits) {
    env.GIT_AUTHOR_DATE=env.GIT_COMMITTER_DATE=new Date(Date.now()-48*3600*1000).toISOString();
  }
  const run=(command,args=[],extra={})=>{
    const r=spawnSync(command,args,{cwd:primary,env,...extra,encoding:'utf8'});
    return {status:r.status,stdout:r.stdout??'',stderr:r.stderr??''};
  };
  const git=(...args)=>{
    const r=run('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args]);
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  mkdirSync(primary);mkdirSync(bins);
  git('init','-q','-b','main');
  writeFileSync(join(primary,'.gitignore'),'node_modules/\n.nx/\n.env\nlocal-state/\n');
  writeFileSync(join(primary,'source.txt'),'base\n');
  git('add','.');git('commit','-qm','base');
  git('worktree','add',...(detached?['--detach']:['-b','feature']),path);
  writeFileSync(join(path,'source.txt'),'unmerged work\n');
  git('-C',path,'commit','-qam','work');
  const head=git('-C',path,'rev-parse','HEAD');
  if(merged) {
    git('merge','--squash',head);git('commit','-qm','squash');
    env.MERGED_PRS_JSON=JSON.stringify([{headRefName:'original-name',headRefOid:head,mergeCommit:{oid:git('rev-parse','HEAD')}}]);
  }
  writeFileSync(join(bins,'gh'),'#!/bin/sh\nif [ "$FAIL_PR_LOOKUP" = yes ]; then exit 1; fi\nif [ "$1" = api ]; then printf \'[%s]\\n\' "$OPEN_PRS_JSON"; else printf \'%s\\n\' "$MERGED_PRS_JSON"; fi\n',{mode:0o755});
  env.PATH=bins+':'+env.PATH;
  const prune=(...args)=>run('bash',[join(here,'prune-merged-worktrees.sh'),'--repo',primary,'--base','main',...args,path]);
  const restore=(archive,...args)=>run('bash',[join(here,'restore-worktree.sh'),archive,...args]);
  const archives=()=> {
    const folder=join(primary,'.git','parked-worktrees');
    return existsSync(folder)?readdirSync(folder).map(n=>join(folder,n)):[];
  };
  return {root,primary,path,bins,env,run,git,head,prune,restore,archives};
}

test('renamed and detached exact merged heads are removable',t=>{
  for(const detached of [false,true]) {
    const f=fixture(t,{detached,merged:true});
    const r=f.prune('--delete');assert.equal(r.status,0,r.stderr+r.stdout);
    assert.match(r.stdout,/REMOVED/);assert.equal(existsSync(f.path),false);
  }
});

test('parking is opt-in and an audit has no archive or removal side effects',t=>{
  const f=fixture(t);
  assert.match(f.prune().stdout,/KEEP.*unverified:unmerged/);
  const r=f.prune('--park-unmerged');
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/SAFE.*parkable:unmerged/);
  assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
});

test('parking preserves history, private ignored files and state, omitting only ignored caches',t=>{
  const f=fixture(t);
  mkdirSync(join(f.path,'node_modules'));writeFileSync(join(f.path,'node_modules','reinstallable.bin'),Buffer.alloc(1024*1024));
  mkdirSync(join(f.path,'local-state'));writeFileSync(join(f.path,'local-state','data.bin'),Buffer.from([0,1,2,255]));
  writeFileSync(join(f.path,'.env'),'FAKE_TEST_VALUE=preserved\n',{mode:0o600});
  // Tracked content under a normally ignored cache name must never be omitted.
  mkdirSync(join(f.path,'.nx'));writeFileSync(join(f.path,'.nx','tracked.txt'),'keep tracked data');
  f.git('-C',f.path,'add','-f','.nx/tracked.txt');f.git('-C',f.path,'commit','-qm','tracked cache-name content');
  const head=f.git('-C',f.path,'rev-parse','HEAD');
  const r=f.prune('--park-unmerged','--delete');assert.equal(r.status,0,r.stderr+r.stdout);
  assert.match(r.stdout,/PARKED/);assert.equal(existsSync(f.path),false);
  assert.equal(f.git('rev-parse','feature'),head);
  const [archive]=f.archives();const manifest=JSON.parse(readFileSync(join(archive,'manifest.json')));
  assert.equal(f.git('rev-parse',manifest.ref),head);
  assert.deepEqual(manifest.excludedCaches,['./node_modules']);
  const restored=f.restore(archive);assert.equal(restored.status,0,restored.stderr);
  assert.equal(readFileSync(join(f.path,'source.txt'),'utf8'),'unmerged work\n');
  assert.equal(readFileSync(join(f.path,'.env'),'utf8'),'FAKE_TEST_VALUE=preserved\n');
  assert.deepEqual(readFileSync(join(f.path,'local-state','data.bin')),Buffer.from([0,1,2,255]));
  assert.equal(readFileSync(join(f.path,'.nx','tracked.txt'),'utf8'),'keep tracked data');
  assert.equal(existsSync(join(f.path,'node_modules')),false);
  assert.equal(f.git('-C',f.path,'rev-parse','HEAD'),head);
  assert.equal(f.git('-C',f.path,'status','--porcelain'),'');
});

test('detached parked history survives garbage collection and restores without branch rewriting',t=>{
  const f=fixture(t,{detached:true});
  const r=f.prune('--park-unmerged','--delete');assert.equal(r.status,0,r.stderr+r.stdout);
  const [archive]=f.archives();f.git('gc','--prune=now');
  assert.equal(f.restore(archive).status,0);assert.equal(f.git('-C',f.path,'rev-parse','HEAD'),f.head);
});

test('dirty, live, locked, and open-PR checkouts are retained even in parking mode',async t=>{
  for(const kind of ['dirty','live','locked','open']) {
    const f=fixture(t);let child;
    if(kind==='dirty')writeFileSync(join(f.path,'source.txt'),'unsaved\n');
    if(kind==='locked')f.git('worktree','lock',f.path);
    if(kind==='open')f.env.OPEN_PRS_JSON=JSON.stringify([{head:{ref:'different-local-name',sha:f.head}}]);
    if(kind==='live') {
      child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:f.path,stdio:'ignore'});
      await new Promise(resolve=>child.once('spawn',resolve));
      t.after(()=>child.kill());
    }
    const r=f.prune('--park-unmerged','--delete');
    assert.equal(r.status,1);assert.match(r.stdout,/KEEP/);assert.equal(existsSync(f.path),true);
    assert.deepEqual(f.archives(),[]);
    if(child){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
  }
});

test('missing ownership evidence and archive failure never delete the checkout',t=>{
  const f=fixture(t);f.env.FAIL_PR_LOOKUP='yes';
  assert.match(f.prune('--park-unmerged','--delete').stdout,/KEEP.*pr-data-unavailable/);
  assert.deepEqual(f.archives(),[]);f.env.FAIL_PR_LOOKUP='';
  writeFileSync(join(f.bins,'tar'),'#!/bin/sh\nexit 99\n',{mode:0o755});
  const r=f.prune('--park-unmerged','--delete');
  assert.equal(r.status,1);assert.match(r.stdout,/FAILED/);
  assert.equal(existsSync(f.path),true);assert.equal(f.git('rev-parse','feature'),f.head);
});

test('large unrelated open-PR lists use one known-ref query, and known descendant PRs protect work',t=>{
  const f=fixture(t);
  f.env.OPEN_PRS_JSON=JSON.stringify(Array.from({length:1000},(_,i)=>({head:{ref:'foreign-'+i,sha:i.toString(16).padStart(40,'0')}})));
  const trace=join(f.root,'git-calls');
  const realGit=spawnSync('which',['git'],{encoding:'utf8'}).stdout.trim();
  f.env.GIT_TRACE_CALLS=trace;f.env.REAL_GIT=realGit;
  writeFileSync(join(f.bins,'git'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$GIT_TRACE_CALLS"\nexec "$REAL_GIT" "$@"\n',{mode:0o755});
  assert.match(f.prune('--park-unmerged').stdout,/SAFE.*parkable/);
  const calls=readFileSync(trace,'utf8').split('\n');
  assert.equal(calls.filter(s=>s.includes('merge-base --is-ancestor')).length,1);
  assert.equal(calls.filter(s=>s.includes('for-each-ref --contains')).length,1);
  f.git('-C',f.path,'checkout','-b','next');
  writeFileSync(join(f.path,'source.txt'),'next\n');f.git('-C',f.path,'commit','-qam','next');
  const next=f.git('-C',f.path,'rev-parse','HEAD');f.git('-C',f.path,'checkout','feature');
  f.env.OPEN_PRS_JSON=JSON.stringify([{head:{ref:'published-name',sha:next}}]);
  assert.match(f.prune('--park-unmerged','--delete').stdout,/KEEP.*open-pr/);
  assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
});

test('initialized submodule history is retained until it can be archived independently',t=>{
  const f=fixture(t);
  f.git('-C',f.path,'-c','protocol.file.allow=always','submodule','add',f.primary,'child');
  f.git('-C',f.path,'commit','-qam','submodule');
  const r=f.prune('--park-unmerged','--delete');
  assert.equal(r.status,1);assert.match(r.stdout,/KEEP.*parking-refused/);
  assert.equal(existsSync(f.path),true);assert.deepEqual(f.archives(),[]);
});

test('restore refuses corrupted archives and preserves a branch moved since parking',t=>{
  const f=fixture(t);assert.equal(f.prune('--park-unmerged','--delete').status,0);
  const [archive]=f.archives();const packed=join(archive,'files.tar.gz'),saved=readFileSync(packed);
  writeFileSync(packed,Buffer.concat([saved,Buffer.from('corruption')]));
  assert.match(f.restore(archive).stderr,/checksum mismatch/);assert.equal(existsSync(f.path),false);
  writeFileSync(packed,saved);const base=f.git('rev-parse','main');f.git('update-ref','refs/heads/feature',base);
  assert.equal(f.restore(archive).status,0);assert.equal(f.git('-C',f.path,'rev-parse','HEAD'),f.head);
  assert.equal(f.git('rev-parse','feature'),base);
});

test('36-hour cutoff includes recent ignored-file writes and Git ref activity',t=>{
  const f=fixture(t,{oldCommits:true});
  delete f.env.GIT_AUTHOR_DATE;delete f.env.GIT_COMMITTER_DATE;
  // Backdated commits also backdate reflogs, so create real recent checkout
  // activity independently before aging only the working-directory files.
  f.git('-C',f.path,'checkout','--detach');f.git('-C',f.path,'checkout','feature');
  const old=new Date(Date.now()-48*3600*1000);
  function ageTree(folder) {
    for(const entry of readdirSync(folder,{withFileTypes:true})) {
      const path=join(folder,entry.name);if(entry.isDirectory())ageTree(path);utimesSync(path,old,old);
    }
    utimesSync(folder,old,old);
  }
  ageTree(f.path);
  // Old file timestamps alone cannot hide a newly created checkout/ref.
  let r=f.prune('--park-unmerged','--idle-hours','36');
  assert.match(r.stdout,/KEEP.*recent:git-ref/);
  for(const log of [join(f.primary,'.git','logs','refs','heads','feature'),join(f.primary,'.git','worktrees','checkout','logs','HEAD')]) {
    const text=readFileSync(log,'utf8').replace(/ \d+ \+0000\t/g,' '+Math.floor(old.getTime()/1000)+' +0000\t');
    writeFileSync(log,text);
  }
  r=f.prune('--park-unmerged','--idle-hours','36');
  assert.match(r.stdout,/SAFE.*parkable/);
  writeFileSync(join(f.path,'.env'),'recent ignored local input\n');
  r=f.prune('--park-unmerged','--idle-hours','36','--delete');
  assert.match(r.stdout,/KEEP.*recent:file/);assert.equal(existsSync(f.path),true);
  assert.deepEqual(f.archives(),[]);
});

test('explicit cold-checkout retirement needs an age window and preserves PR work without GitHub access',t=>{
  const f=fixture(t,{oldCommits:true});
  const old=new Date(Date.now()-48*3600*1000);
  for(const name of readdirSync(f.path))utimesSync(join(f.path,name),old,old);
  utimesSync(f.path,old,old);
  f.env.FAIL_PR_LOOKUP='yes';
  assert.equal(f.prune('--park-inactive','--delete').status,2);
  assert.equal(existsSync(f.path),true);
  const r=f.prune('--park-inactive','--idle-hours','36','--delete');
  assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/PARKED/);
  assert.equal(f.git('rev-parse','feature'),f.head);
  const [archive]=f.archives();assert.equal(f.restore(archive).status,0);
  assert.equal(f.git('-C',f.path,'rev-parse','HEAD'),f.head);
  // A recent write keeps the restored checkout, regardless of PR metadata.
  writeFileSync(join(f.path,'source.txt'),'still working\n');
  const kept=f.prune('--park-inactive','--idle-hours','36','--delete');
  assert.equal(kept.status,1);assert.match(kept.stdout,/KEEP.*dirty/);
});
