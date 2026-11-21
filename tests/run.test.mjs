import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loginCommand,logoutCommand,runCommand,loadStore,secretToolStore} from '../dist/run/index.js';
import {EXIT} from '../dist/gate/index.js';

// Synthetic values only; no real network, keychain, tokens or customers.
const TOKEN='zofcli_'+'Ab3dE5'.repeat(6);
const CONSOLE='https://console.example.test';
const SHA='1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const RUN='mrun_01HZX3K9Q7W2M4N5P6R7S8T9VA';
const T1='mtsk_01HZX3K9Q7W2M4N5P6R7S8T9V1',T2='mtsk_01HZX3K9Q7W2M4N5P6R7S8T9V2',T3='mtsk_01HZX3K9Q7W2M4N5P6R7S8T9V3';
const PLAN='9f'.repeat(32);
const NOW=Date.parse('2030-01-01T00:00:00Z');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const json=(status,body,headers={})=>({status,headers:{'content-type':'application/json',...headers},text:JSON.stringify(body)});
const signedIn=(over={})=>JSON.stringify({v:1,console:CONSOLE,token:TOKEN,expires_at:NOW+3600_000,...over});

function memoryStore(initial=null){let value=initial;return {name:'the test keychain',get:async()=>value,set:async s=>{value=s;},delete:async()=>{const had=value!==null;value=null;return had;},peek:()=>value};}

/** Runs a command against scripted console routes, a spawn spy and a fake clock. */
async function harness(command,argv,{store=memoryStore(signedIn()),routes={},interactive=false,answers=[],env={},spawnScript=()=>({code:1,stdout:''}),interruptOn}={}){
  let t=NOW;const requests=[];const lines=[];const spawns=[];const sleeps=[];const queues=Object.fromEntries(Object.entries(routes).map(([k,v])=>[k,[...v]]));let interrupt=()=>{};let asked=[];
  const http=async req=>{const url=new URL(req.url);requests.push({...req,path:url.pathname+url.search,json:req.body?JSON.parse(req.body):undefined});
    const key=`${req.method} ${url.pathname}`;const q=queues[key];if(!q||!q.length)throw new Error('no route '+key);const next=q.length>1?q.shift():q[0];
    if(interruptOn&&interruptOn(req))interrupt();const r=typeof next==='function'?next(req):next;if(r instanceof Error)throw r;return r;};
  const spawn=async(command,args,options={})=>{spawns.push({command,args:[...args],stdin:options.stdin});return spawnScript(command,args,options);};
  const deps={version:'0.0.0-test',env,http,spawn,store:async()=>store,now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;},uuid:()=>crypto.randomUUID(),
    write:(stream,line)=>lines.push({stream,line}),interactive,ask:async q=>{asked.push(q);return answers.shift()??null;},onInterrupt:h=>{interrupt=h;return()=>{interrupt=()=>{};};}};
  const fn=command==='login'?loginCommand:command==='logout'?logoutCommand:runCommand;
  const code=await fn(argv,deps);
  return {code,requests,lines,spawns,sleeps,asked,store,out:lines.map(l=>l.line).join('\n')};
}

const task=(id,over={})=>({task_id:id,category:'security',title:'Headers',state:'proposed',default_ticked:true,gate:{ok:true},...over});
const planned=(over={})=>json(200,{run_id:RUN,state:'planned',plan_sha256:PLAN,plan_expires_at:'2030-01-01T00:30:00Z',billing:{mode:'credits',estimate_credits:12},
  tasks:[task(T1),task(T2,{title:'Login flow',default_ticked:false,gate:{ok:false,code:'address_not_verified',message:'Prove you control the address first.'}}),task(T3,{category:'privacy',title:'Cookies',default_ticked:false})],...over});
const runArgs=['--repo','acme/app','--commit',SHA,'--site','https://staging.example.test','--site-env','staging','--category','security','--category','privacy'];
const happyRoutes=(over={})=>({
  'POST /api/runs/plan':[json(202,{run_id:RUN,state:'planning'})],
  [`GET /api/runs/${RUN}`]:[json(200,{run_id:RUN,state:'planning'}),planned(),json(200,{run_id:RUN,state:'finished',tasks:[task(T1,{state:'finished',outcome:'passed'})]})],
  [`POST /api/runs/${RUN}/start`]:[json(202,{run_id:RUN,tasks:[{task_id:T1,child_run_id:null}]})],
  [`GET /api/runs/${RUN}/events`]:[json(200,{run_id:RUN,state:'running',events:[{seq:1,type:'manual_run.task.state',task_id:T1,detail:{from:'proposed',to:'running'}},{seq:2,type:'manual_run.task.finding',task_id:T1,detail:{title:'Missing HSTS',severity:'low',confirmed:true}},{seq:3,type:'manual_run.task.finding',task_id:T1,detail:{title:'Maybe',severity:'high',confirmed:false}}],next_after:3}),
    json(200,{run_id:RUN,state:'finished',events:[{seq:4,type:'manual_run.task.outcome',task_id:T1,detail:{outcome:'passed'}}],next_after:4})],
  ...over,
});
const noToken=r=>{assert.ok(!r.out.includes(TOKEN),'the token is never printed');for(const s of r.spawns)assert.ok(!s.args.some(a=>a.includes(TOKEN)),'no argv carries the token: '+s.args.join(' '));};

// ── zof login ────────────────────────────────────────────────────────────────

const authorize=json(200,{device_code:'dc_123',user_code:'ABCD-EFGH',verification_uri:CONSOLE+'/device',verification_uri_complete:CONSOLE+'/device?user_code=ABCD-EFGH',expires_in:600,interval:5});
const tokenOk=json(200,{access_token:TOKEN,token_type:'Bearer',expires_in:43200,scope:'runs'});

test('login: the device flow with the runs scope, kept only in the keychain',async()=>{
  const store=memoryStore();
  const r=await harness('login',['--console-url',CONSOLE],{store,routes:{'POST /api/auth/device/authorize':[authorize],'POST /api/auth/device/token':[json(400,{error:'authorization_pending'}),json(400,{error:'slow_down'}),tokenOk]}});
  assert.equal(r.code,EXIT.pass,r.out);
  assert.deepEqual(r.requests[0].json,{client_id:'zof-cli-app',scope:'runs',cli_metadata:{client:'zof',version:'0.0.0-test'}});
  assert.deepEqual(r.requests[1].json,{grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:'zof-cli-app',device_code:'dc_123'});
  assert.deepEqual(r.sleeps,[5000,5000,10000],'slow_down widens the interval');
  const saved=JSON.parse(store.peek());assert.deepEqual(saved,{v:1,console:CONSOLE,token:TOKEN,expires_at:NOW+20_000+43200_000});
  assert.match(r.out,/ABCD-EFGH/);assert.match(r.out,/Saved in the test keychain/);noToken(r);
});

test('login: no keychain means no sign-in, before any network call',async()=>{
  const r=await harness('login',['--console-url',CONSOLE],{store:null,env:{ZOF_CLI_TOKEN:TOKEN}});
  assert.equal(r.code,EXIT.config);assert.equal(r.requests.length,0);assert.equal(r.spawns.length,0);
  assert.match(r.out,/never keeps a sign-in in a file or an environment variable/);
});

test('login: refusals and unusable answers save nothing',async()=>{
  for(const [routes,exit,needle] of [
    [{'POST /api/auth/device/authorize':[json(200,{...JSON.parse(authorize.text),verification_uri_complete:'https://evil.example.test/device'})]},EXIT.unavailable,/could not be used/],
    [{'POST /api/auth/device/authorize':[authorize],'POST /api/auth/device/token':[json(200,{access_token:TOKEN,expires_in:60,scope:'cli'})]},EXIT.unavailable,/nothing was saved/],
    [{'POST /api/auth/device/authorize':[authorize],'POST /api/auth/device/token':[json(400,{error:'access_denied'})]},EXIT.token,/denied/],
    [{'POST /api/auth/device/authorize':[authorize],'POST /api/auth/device/token':[json(400,{error:'expired_token'})]},EXIT.token,/expired/],
    [{'POST /api/auth/device/authorize':[json(401,{error:'invalid_client'})]},EXIT.config,/invalid_client/],
  ]){const store=memoryStore();const r=await harness('login',['--console-url',CONSOLE],{store,routes});assert.equal(r.code,exit,r.out);assert.match(r.out,needle);assert.equal(store.peek(),null);noToken(r);}
  const noUrl=await harness('login',[],{store:memoryStore()});assert.equal(noUrl.code,EXIT.config);assert.match(noUrl.out,/ZOF_CONSOLE_URL/);
  const plain=await harness('login',['--console-url','http://console.example.test'],{store:memoryStore()});assert.equal(plain.code,EXIT.config);assert.match(plain.out,/https/);
});

// ── zof logout ───────────────────────────────────────────────────────────────

test('logout: revokes the sign-in in Zof and removes it here',async()=>{
  const store=memoryStore(signedIn());
  const r=await harness('logout',[],{store,routes:{'POST /api/auth/device/revoke':[json(200,{ok:true})]}});
  assert.equal(r.code,EXIT.pass,r.out);assert.equal(store.peek(),null);
  assert.equal(r.requests[0].headers.authorization,'Bearer '+TOKEN);assert.deepEqual(r.requests[0].json,{});noToken(r);
});

test('logout: removed here even when Zof cannot revoke, and says so',async()=>{
  for(const answer of [json(401,{error:'UNAUTHENTICATED'}),json(403,{code:'cli_scope_not_allowed'}),new Error('offline')]){
    const store=memoryStore(signedIn());
    const r=await harness('logout',[],{store,routes:{'POST /api/auth/device/revoke':[answer]}});
    assert.equal(r.code,EXIT.unavailable,r.out);assert.equal(store.peek(),null);assert.match(r.out,/Removed from this computer, but Zof could not revoke/);noToken(r);
  }
  const none=await harness('logout',[],{store:memoryStore()});assert.equal(none.code,EXIT.pass);assert.match(none.out,/not signed in/);
});

// ── zof run ──────────────────────────────────────────────────────────────────

test('run: plans, shows gates and price, starts exactly the ticked tests, follows to the end',async()=>{
  const r=await harness('run',[...runArgs,'--authorize','https://staging.example.test','--yes'],{routes:happyRoutes()});
  assert.equal(r.code,EXIT.pass,r.out);
  const plan=r.requests.find(q=>q.path==='/api/runs/plan');
  assert.deepEqual(plan.json,{repo:'acme/app',sha:SHA,ref:{kind:'commit',label:SHA},site_url:'https://staging.example.test',environment:{site:'staging'},categories:['security','privacy']});
  assert.equal(plan.headers.authorization,'Bearer '+TOKEN);assert.match(plan.headers['idempotency-key'],UUID);
  const start=r.requests.find(q=>q.path===`/api/runs/${RUN}/start`);
  assert.deepEqual(start.json,{plan_sha256:PLAN,approved_task_ids:[T1],authorized_origins:['https://staging.example.test']});
  assert.match(start.headers['idempotency-key'],UUID);
  assert.match(r.out,/\[x\] Headers/);assert.match(r.out,/\[ \] Login flow: Prove you control the address first\. \(address_not_verified\)/);
  assert.match(r.out,/\[ \] Cookies: Not started from here/);assert.match(r.out,/Price: 12 credits · plan 9f9f9f9f9f9f/);
  assert.match(r.out,/Headers: finding \(low\) Missing HSTS/);assert.ok(!r.out.includes('Maybe'),'unconfirmed findings stay on the run page');
  assert.match(r.out,/Run finished: 1 passed, 0 found issues, 0 couldn't be checked/);
  assert.ok(r.requests.some(q=>q.path===`/api/runs/${RUN}/events?after=3`),'events resume after the last sequence');
  assert.ok(!r.requests.some(q=>q.path.endsWith('/cancel')));noToken(r);
});

test('run: a terminal still asks even with --yes; anything but yes starts nothing',async()=>{
  const r=await harness('run',[...runArgs,'--yes'],{interactive:true,answers:['n'],routes:happyRoutes()});
  assert.equal(r.code,EXIT.pass);assert.deepEqual(r.asked,['Run 1 test for 12 credits? [y/N] ']);
  assert.ok(!r.requests.some(q=>q.path.endsWith('/start')));assert.match(r.out,/Not started/);
  const yes=await harness('run',runArgs,{interactive:true,answers:['y'],routes:happyRoutes()});assert.equal(yes.code,EXIT.pass,yes.out);
  assert.ok(yes.requests.some(q=>q.path.endsWith('/start')));
});

test('run: without a terminal it needs --yes, and starts nothing without it',async()=>{
  const r=await harness('run',runArgs,{routes:happyRoutes()});
  assert.equal(r.code,EXIT.config);assert.match(r.out,/Pass --yes/);assert.ok(!r.requests.some(q=>q.path.endsWith('/start')));
});

test('run: Ctrl-C stops following and never cancels',async()=>{
  const r=await harness('run',[...runArgs,'--yes'],{routes:happyRoutes({[`GET /api/runs/${RUN}/events`]:[json(200,{run_id:RUN,state:'running',events:[],next_after:0})]}),interruptOn:req=>req.url.includes('/events')});
  assert.equal(r.code,EXIT.blocked);assert.match(r.out,/Stopped following\. The run keeps going/);assert.match(r.out,new RegExp(`zof run cancel ${RUN}`));
  assert.ok(!r.requests.some(q=>q.path.endsWith('/cancel')));
});

test('run: found issues or an unchecked test exit 1',async()=>{
  const r=await harness('run',[...runArgs,'--yes'],{routes:happyRoutes({[`GET /api/runs/${RUN}`]:[planned(),json(200,{run_id:RUN,state:'finished',tasks:[task(T1,{outcome:'found_issues'})]})]})});
  assert.equal(r.code,EXIT.blocked);assert.match(r.out,/1 found issues/);
});

test('run: not signed in, expired, or only an env var is exit 4 with nothing sent',async()=>{
  for(const store of [memoryStore(),memoryStore(signedIn({expires_at:NOW-1})),memoryStore('not json'),null]){
    const r=await harness('run',[...runArgs,'--yes'],{store,env:{ZOF_TOKEN:TOKEN,ZOF_CLI_TOKEN:TOKEN},routes:happyRoutes()});
    assert.equal(r.code,EXIT.token,r.out);assert.equal(r.requests.length,0);assert.match(r.out,/zof login/);
  }
});

test('run: refusals print the console code; 401 is the sign-in; outages honour Retry-After',async()=>{
  const forbidden=await harness('run',[...runArgs,'--yes'],{routes:{'POST /api/runs/plan':[json(403,{code:'forbidden_permission'})]}});
  assert.equal(forbidden.code,EXIT.config);assert.match(forbidden.out,/code: forbidden_permission/);
  const gone=await harness('run',[...runArgs,'--yes'],{routes:{'POST /api/runs/plan':[json(401,{error:'unauthorized'})]}});
  assert.equal(gone.code,EXIT.token);assert.match(gone.out,/zof login/);
  const busy=await harness('run',[...runArgs,'--yes'],{routes:{'POST /api/runs/plan':[json(503,{code:'unavailable'},{'retry-after':'7'})]}});
  assert.equal(busy.code,EXIT.unavailable);assert.deepEqual(busy.sleeps,[7000,7000,7000]);
  const changed=await harness('run',[...runArgs,'--yes'],{routes:happyRoutes({[`POST /api/runs/${RUN}/start`]:[json(409,{code:'plan_changed'})]})});
  assert.equal(changed.code,EXIT.config);assert.match(changed.out,/code: plan_changed/);
});

test('run: never a stack trace, never a terminal escape from the server',async()=>{
  const weird=await harness('run',[...runArgs,'--yes'],{routes:{'POST /api/runs/plan':[()=>{throw new TypeError('boom '+TOKEN);}]}});
  assert.equal(weird.code,EXIT.unavailable);assert.ok(!/\n\s+at /.test(weird.out));noToken(weird);
  const escape=await harness('run',[...runArgs,'--yes'],{routes:happyRoutes({[`GET /api/runs/${RUN}`]:[planned({tasks:[task(T1,{title:'Head\u001b[31mers\u0007'})]}),json(200,{run_id:RUN,state:'finished',tasks:[task(T1,{outcome:'passed'})]})]})});
  assert.ok(!/[\u0000-\u001f]/.test(escape.lines.map(l=>l.line).join('')),'no control characters reach the terminal');
});

test('run: an unreadable price is never free; nothing startable starts nothing',async()=>{
  const r=await harness('run',[...runArgs,'--yes'],{routes:happyRoutes({[`GET /api/runs/${RUN}`]:[planned({billing:{mode:'credits',estimate_credits:null},tasks:[task(T2,{default_ticked:false,gate:{ok:false,message:'Tick it in Zof.'}})]})]})});
  assert.equal(r.code,EXIT.config);assert.match(r.out,/a price Zof will show you/);assert.match(r.out,/None of these tests can start from here/);
  assert.ok(!r.requests.some(q=>q.path.endsWith('/start')));
});

test('run: invalid input is exit 2 before any keychain or network use',async()=>{
  for(const argv of [['--commit',SHA,'--site','https://a.test','--category','security'],['--repo','acme/app','--site','https://a.test','--category','security'],['--repo','acme/app','--commit','abc','--site','https://a.test','--category','security'],
    ['--repo','acme/app','--commit',SHA,'--category','security'],['--repo','acme/app','--commit',SHA,'--site','https://a.test/path','--category','security'],['--repo','acme/app','--commit',SHA,'--site','https://a.test'],
    [...runArgs,'--authorize','ftp://x'],[...runArgs,'--wat']]){
    const r=await harness('run',argv,{routes:happyRoutes()});assert.equal(r.code,EXIT.config,argv.join(' '));assert.equal(r.requests.length,0);
  }
});

test('run --pr reads the head from this checkout, only when origin is that repository',async()=>{
  const git=(command,args)=>args[0]==='remote'?{code:0,stdout:'git@github.com:acme/app.git\n'}:{code:0,stdout:`${SHA}\trefs/pull/12/head\n`};
  const argv=['--repo','acme/app','--pr','12','--site','https://staging.example.test','--category','security','--yes'];
  const r=await harness('run',argv,{routes:happyRoutes(),spawnScript:git});
  assert.equal(r.code,EXIT.pass,r.out);
  assert.deepEqual(r.spawns.map(s=>[s.command,...s.args]),[['git','remote','get-url','origin'],['git','ls-remote','--','origin','refs/pull/12/head']]);
  const plan=r.requests.find(q=>q.path==='/api/runs/plan');assert.equal(plan.json.sha,SHA);assert.deepEqual(plan.json.ref,{kind:'pr',label:'#12'});
  const other=await harness('run',argv,{routes:happyRoutes(),spawnScript:(c,a)=>a[0]==='remote'?{code:0,stdout:'https://github.com/acme/other.git\n'}:git(c,a)});
  assert.equal(other.code,EXIT.config);assert.match(other.out,/--commit/);assert.ok(!other.requests.some(q=>q.path==='/api/runs/plan'));
});

test('run cancel cancels the named run',async()=>{
  const r=await harness('run',['cancel',RUN],{routes:{[`POST /api/runs/${RUN}/cancel`]:[json(202,{run_id:RUN})]}});
  assert.equal(r.code,EXIT.pass);assert.deepEqual(r.requests[0].json,{});assert.match(r.out,/Cancelling/);
  const bad=await harness('run',['cancel','nope']);assert.equal(bad.code,EXIT.config);
});

// ── the keychain ─────────────────────────────────────────────────────────────

test('spawn spy: no process argv ever carries the token across login, run and logout',async()=>{
  // The secret-tool fallback is the only path that starts a process with the secret, and it goes through stdin.
  const seen=[];let kept=null;
  const tool=async(command,args,options={})=>{seen.push({command,args:[...args],stdin:options.stdin});
    if(command==='secret-tool'&&args[0]==='store'){kept=options.stdin;return {code:0,stdout:''};}
    if(command==='secret-tool'&&args[0]==='lookup')return kept?{code:0,stdout:kept+'\n'}:{code:1,stdout:''};
    if(command==='secret-tool'&&args[0]==='clear'){kept=null;return {code:0,stdout:''};}
    if(args[0]==='remote')return {code:0,stdout:'https://github.com/acme/app.git\n'};
    return {code:0,stdout:`${SHA}\trefs/pull/12/head\n`};};
  const store=secretToolStore(tool);
  const login=await harness('login',['--console-url',CONSOLE],{store,routes:{'POST /api/auth/device/authorize':[authorize],'POST /api/auth/device/token':[tokenOk]},spawnScript:tool});
  assert.equal(login.code,EXIT.pass,login.out);
  const run=await harness('run',['--repo','acme/app','--pr','12','--site','https://staging.example.test','--category','security','--yes'],{store,routes:happyRoutes(),spawnScript:tool});
  assert.equal(run.code,EXIT.pass,run.out);
  const out=await harness('logout',[],{store,routes:{'POST /api/auth/device/revoke':[json(200,{ok:true})]},spawnScript:tool});
  assert.equal(out.code,EXIT.pass,out.out);
  const all=[...seen,...login.spawns,...run.spawns,...out.spawns];
  assert.ok(all.length>=5);
  for(const s of all)assert.ok(!s.args.some(a=>a.includes(TOKEN)),`argv of ${s.command} carries the token`);
  const stored=seen.find(s=>s.args[0]==='store');assert.ok(stored.stdin.includes(TOKEN),'the token reached the keyring through stdin');
  assert.equal(kept,null,'logout cleared the keyring');
});

test('the keychain: the native binding first, secret-tool only on Linux, otherwise none',async()=>{
  const calls=[];const spy=async(c,a)=>{calls.push([c,...a]);return {code:1,stdout:''};};
  class Entry{constructor(s,a){this.key=s+'/'+a;}getPassword(){return Entry.v??null;}setPassword(p){Entry.v=p;}deletePassword(){const had=Entry.v!=null;Entry.v=null;return had;}}
  const native=await loadStore({platform:'darwin',spawn:spy,native:async()=>({Entry})});
  await native.set('secret-value-123');assert.equal(await native.get(),'secret-value-123');assert.equal(await native.delete(),true);
  assert.equal(native.name,'the macOS Keychain');assert.equal(calls.length,0,'the native binding starts no process');
  const missing=async()=>{throw new Error('no prebuilt binding');};
  assert.equal(await loadStore({platform:'darwin',spawn:spy,native:missing}),null);
  assert.equal(await loadStore({platform:'win32',spawn:spy,native:missing}),null);
  const linux=await loadStore({platform:'linux',spawn:spy,native:missing});assert.equal(linux.name,'the Secret Service keyring (secret-tool)');
  assert.equal(await loadStore({platform:'linux',spawn:async()=>{throw new Error('ENOENT');},native:missing}),null);
});
