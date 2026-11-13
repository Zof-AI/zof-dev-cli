import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gateCommand,redact,detectCi,parseAnswer,EXIT} from '../dist/gate/index.js';

// Synthetic values only; no real network, tokens or customers.
const TOKEN='zgt_'+'A1b2C3d4'.repeat(5)+'xyz';
const SHA='1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const GATE='gate_'+'0'.repeat(31)+'1';
const API='https://cp.example.test';
const answer=(over={})=>({schema_version:1,kind:'gate_check',gate_id:GATE,tenant_id:'github:org:1',change_id:'chg_1',correlation_id:'c1',repo:'acme/app',commit_sha:SHA,environment:'production',policy_environment:'production',state:'final',result:'pass',basis:'decision',verdict:'allow',waiting_for:null,reasons:[],failure:null,decision_id:'d1',inputs_hash:'h',authorization_id:'auth_1',console_url:'https://console.example.test/releases/pr/1',approve_url:null,wait_until:'2030-01-01T00:10:00Z',poll_after_seconds:5,answered_at:'2030-01-01T00:00:01Z',...over});
const waiting=(over={})=>answer({state:'waiting',result:'waiting',basis:null,verdict:'require_evidence',waiting_for:'evidence',authorization_id:null,reasons:[{code:'MISSING_BLOCKING_EVIDENCE',requirement_key:'performance.load',message:'Load test evidence is missing.',remedy:'run_capability'}],...over});
const json=(status,body,headers={})=>({status,headers:{'content-type':'application/json',...headers},text:JSON.stringify(body)});
const fail=(code,detail='x')=>({code,detail});
const baseEnv={ZOF_GATE_TOKEN:TOKEN,ZOF_API_URL:API};
const args=['decide','--environment','production','--repo','acme/app','--commit',SHA,'--run-id','42'];

/** Runs the command against a scripted fake server and a fake clock. */
async function run({argv=args,env=baseEnv,responses=[],files={}}={}){
  let t=Date.parse('2030-01-01T00:00:00Z');const requests=[];const lines=[];const sleeps=[];const queue=[...responses];
  const http=async req=>{requests.push({...req,at:t});const next=queue.length>1?queue.shift():queue[0];if(!next)throw new Error('no response scripted');const r=typeof next==='function'?await next(req,{advance:ms=>{t+=ms;}}):next;if(r instanceof Error)throw r;return r;};
  const code=await gateCommand(argv,{version:'0.0.0-test',env,http,now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;},random:()=>0.5,readFile:async p=>{if(p in files)return files[p];throw new Error('ENOENT '+p);},write:(stream,line)=>lines.push({stream,line})});
  return {code,requests,lines,sleeps,out:lines.map(l=>l.line).join('\n'),elapsed:t-Date.parse('2030-01-01T00:00:00Z')};
}

test('exit 0: a final pass backed by a stored ALLOW',async()=>{
  const r=await run({responses:[json(201,answer())]});
  assert.equal(r.code,EXIT.pass);assert.equal(r.requests.length,1);
  const req=r.requests[0];assert.equal(req.method,'POST');assert.equal(req.url,API+'/v1/gate/checks');
  assert.equal(req.headers.authorization,'Bearer '+TOKEN);assert.equal(req.headers['idempotency-key'],'other:42:1:gate:production');
  assert.match(req.headers['user-agent'],/^zof-gate\/0\.0\.0-test \(other\)$/);
  const body=JSON.parse(req.body);assert.deepEqual(body,{schema_version:1,repo:'acme/app',commit_sha:SHA,environment:'production',pipeline:{provider:'other',run_id:'42',run_attempt:1,job:'gate'}});
  assert.match(r.out,/Passed/);
});

test('exit 1: a final DENY lists the reasons and the console link',async()=>{
  const r=await run({responses:[json(201,answer({result:'fail',basis:null,verdict:'deny',authorization_id:null,failure:{code:'denied',message:'The deploy decision is DENY.'},reasons:[{code:'SECURITY',message:'Security injection checks failed.',remedy:'fix_and_push'}]}))]});
  assert.equal(r.code,EXIT.blocked);assert.match(r.out,/Blocked/);assert.match(r.out,/Security injection checks failed/);assert.match(r.out,/console\.example\.test/);
});

test('exit 1: commit_unknown is a block, not a config error',async()=>{
  const r=await run({responses:[json(409,fail('commit_unknown','Zof has no change for this commit.'))]});
  assert.equal(r.code,EXIT.blocked);
});

test('exit 2: configuration problems say what to fix and send nothing',async()=>{
  for(const [env,argv,needle] of [
    [{ZOF_API_URL:API},args,/ZOF_GATE_TOKEN is not set/],
    [{ZOF_GATE_TOKEN:TOKEN},args,/ZOF_API_URL/],
    [baseEnv,['decide','--repo','acme/app','--commit',SHA,'--run-id','42'],/--environment/],
    [baseEnv,['decide','--environment','production','--commit',SHA,'--run-id','42'],/--repo/],
    [baseEnv,[...args,'--wat','1'],/Unknown option/],
    [baseEnv,['decide','--environment','Prod EU','--repo','acme/app','--commit',SHA,'--run-id','42'],/environment/],
    [baseEnv,['decide','--environment','production','--repo','acme/app','--commit','abc','--run-id','42'],/--commit/],
    [{...baseEnv,ZOF_API_URL:'http://cp.example.test'},args,/https/],
    [baseEnv,[...args,'--max-wait','0'],/--max-wait/],
  ]){const r=await run({env,argv,responses:[json(201,answer())]});assert.equal(r.code,EXIT.config,r.out);assert.equal(r.requests.length,0);assert.match(r.out,needle);assert.match(r.out,/your pipeline/i);}
});

test('exit 2: server config codes map to 2 and pass on the detail',async()=>{
  for(const [status,code] of [[422,'unknown_environment'],[404,'repo_not_found'],[409,'commit_ambiguous'],[409,'idempotency_conflict'],[422,'invalid_body'],[413,'payload_too_large']]){
    const r=await run({responses:[json(status,fail(code,'Detail from Zof for '+code))]});assert.equal(r.code,EXIT.config,code);assert.match(r.out,new RegExp(code));
  }
});

test('exit 3: outages are retried with backoff, then fail closed as on Zof\'s side',async()=>{
  const r=await run({responses:[new Error('getaddrinfo ENOTFOUND cp.example.test')]});
  assert.equal(r.code,EXIT.unavailable);assert.ok(r.requests.length>=3&&r.requests.length<=6,String(r.requests.length));
  assert.match(r.out,/on Zof's side/);assert.match(r.out,/never passes/);
  for(let i=1;i<r.sleeps.length;i++)assert.ok(r.sleeps[i]>=r.sleeps[i-1],'backoff grows');
  const busy=await run({responses:[json(503,fail('unavailable'),{'retry-after':'7'})]});
  assert.equal(busy.code,EXIT.unavailable);assert.ok(busy.sleeps.every(ms=>ms===7000),String(busy.sleeps));
});

test('exit 3: a mismatched, malformed or unverifiable answer is no answer',async()=>{
  for(const body of [answer({commit_sha:'f'.repeat(40)}),answer({repo:'acme/other'}),answer({environment:'staging'}),answer({basis:null}),answer({verdict:'deny'}),answer({authorization_id:null}),answer({basis:'break_glass'}),answer({state:'waiting'}),{hello:'world'}]){
    const r=await run({responses:[json(201,body)]});assert.equal(r.code,EXIT.unavailable,JSON.stringify(body).slice(0,120));
  }
  const html=await run({responses:[{status:200,headers:{'content-type':'text/html'},text:'<html>proxy</html>'}]});assert.equal(html.code,EXIT.unavailable);
  const redirect=await run({responses:[{status:302,headers:{location:'https://elsewhere.example.test'},text:''}]});assert.equal(redirect.code,EXIT.unavailable);
});

test('exit 4: token problems point at the pipeline token',async()=>{
  for(const [status,code] of [[401,'unauthorized'],[401,'token_expired'],[403,'insufficient_scope'],[403,'gate_not_enabled'],[403,'company_unbound'],[403,'environment_not_allowed']]){
    const r=await run({responses:[json(status,fail(code))]});assert.equal(r.code,EXIT.token,code);assert.match(r.out,/token|Zof/);
  }
  const bad=await run({env:{...baseEnv,ZOF_GATE_TOKEN:'ghp_notazoftoken1234567890'},responses:[json(201,answer())]});
  assert.equal(bad.code,EXIT.token);assert.equal(bad.requests.length,0);assert.match(bad.out,/zgt_/);
});

test('--break-glass is refused in this version and sends nothing',async()=>{
  const r=await run({argv:[...args,'--break-glass','hotfix'],responses:[json(201,answer())]});
  assert.notEqual(r.code,EXIT.pass);assert.equal(r.requests.length,0);
});

test('polling: waits, honours poll_after_seconds and Retry-After, then passes',async()=>{
  const r=await run({responses:[json(202,waiting({poll_after_seconds:5})),json(429,fail('rate_limited'),{'retry-after':'3'}),json(200,waiting({poll_after_seconds:2})),json(200,answer())]});
  assert.equal(r.code,EXIT.pass);assert.equal(r.requests.length,4);
  assert.deepEqual(r.requests.slice(1).map(q=>q.method),['GET','GET','GET']);
  for(const q of r.requests.slice(1)){assert.equal(q.url,`${API}/v1/gate/checks/${GATE}?wait=20`);assert.equal(q.body,undefined);}
  assert.deepEqual(r.sleeps,[5000,3000,2000]);assert.match(r.out,/Waiting for evidence/);assert.match(r.out,/performance\.load/);
});

test('timeout: the default wait is 10 minutes and a still-waiting gate blocks (exit 1)',async()=>{
  const longPoll=(req,{advance})=>{if(req.method==='GET')advance(20000);return json(req.method==='POST'?202:200,waiting({wait_until:'2030-01-01T01:00:00Z'}));};
  const r=await run({responses:[longPoll]});
  assert.equal(r.code,EXIT.blocked);assert.ok(r.elapsed>=10*60000&&r.elapsed<10*60000+30000,String(r.elapsed));
  assert.match(r.out,/10 min/);assert.match(r.out,/--max-wait/);
  const short=await run({argv:[...args,'--max-wait','2'],responses:[longPoll]});
  assert.equal(short.code,EXIT.blocked);assert.ok(short.elapsed>=2*60000&&short.elapsed<2*60000+30000,String(short.elapsed));
  for(const q of short.requests.filter(q=>q.method==='GET'))assert.ok(q.at+20000<=Date.parse('2030-01-01T00:02:00Z')+20000);
});

test('timeout: a server that keeps waiting past its own deadline is on Zof\'s side (exit 3)',async()=>{
  const r=await run({responses:[(req,{advance})=>{advance(20000);return json(req.method==='POST'?202:200,waiting({wait_until:'2030-01-01T00:01:00Z'}));}]});
  assert.equal(r.code,EXIT.unavailable);assert.match(r.out,/on Zof's side/);
});

test('--no-wait answers once: a waiting gate is not a pass',async()=>{
  const r=await run({argv:[...args,'--no-wait'],responses:[json(202,waiting())]});
  assert.equal(r.code,EXIT.blocked);assert.equal(r.requests.length,1);
});

test('404: mid-poll on our own gate id is on Zof\'s side (3); on the first call it stays config (2)',async()=>{
  const r=await run({responses:[json(202,waiting()),json(404,fail('not_found'))]});assert.equal(r.code,EXIT.unavailable);assert.match(r.out,/on Zof's side/);
  for(const code of ['not_found','repo_not_found',undefined]){const first=await run({responses:[json(404,code?fail(code):{})]});assert.equal(first.code,EXIT.config,String(code));assert.equal(first.requests.length,1);}
});

test('outages never pass: every failure kind exits non-zero, and every outage exits exactly 3',async()=>{
  const outages=[new Error('ECONNRESET'),new Error('The operation was aborted due to timeout'),json(500,fail('boom')),json(502,{}),json(503,fail('policy_lagging')),json(504,{}),json(429,fail('rate_limited')),{status:200,headers:{},text:'not json'},{status:201,headers:{},text:''},json(200,null),json(200,[]),{status:301,headers:{},text:''},{status:100,headers:{},text:''}];
  for(const o of outages){const r=await run({responses:[o]});assert.equal(r.code,EXIT.unavailable,String(o.status??o.message));}
  // Outage after the gate started waiting is still 3, never 0.
  for(const o of outages){const r=await run({responses:[json(202,waiting()),o]});assert.equal(r.code,EXIT.unavailable,'mid-poll '+String(o.status??o.message));}
  // Random statuses and bodies: only a valid matching pass exits 0.
  let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  const statuses=[200,201,202,204,301,400,401,403,404,409,413,418,422,429,500,503];
  const bodies=[()=>answer({result:'fail'}),()=>answer({state:'waiting'}),()=>answer({basis:'baseline',verdict:'deny'}),()=>answer({gate_id:'gate_x'}),()=>waiting(),()=>fail('unauthorized'),()=>({}),()=>'zgt_'];
  for(let i=0;i<200;i++){const status=statuses[Math.floor(rnd()*statuses.length)];const body=bodies[Math.floor(rnd()*bodies.length)]();const r=await run({argv:[...args,'--no-wait'],responses:[json(status,body)]});assert.notEqual(r.code,EXIT.pass,`${status} ${JSON.stringify(body).slice(0,80)}`);}
  const baseline=await run({responses:[json(201,answer({basis:'baseline',verdict:null,authorization_id:null,decision_id:null}))]});assert.equal(baseline.code,EXIT.pass);
});

test('token redaction: the token never reaches the log, even when echoed back',async()=>{
  const echo=await run({responses:[json(401,fail('unauthorized',`Bearer ${TOKEN} was rejected; also zbg_abc zdt_def zct_ghi`))]});
  assert.equal(echo.code,EXIT.token);assert.ok(!echo.out.includes(TOKEN));assert.ok(!/z(gt|bg|dt|ct)_[A-Za-z0-9]/.test(echo.out),echo.out);
  const thrown=await run({responses:[new Error(`connect failed for ${TOKEN}`)]});assert.ok(!thrown.out.includes(TOKEN));
  const asJson=await run({argv:[...args,'--json'],responses:[json(201,answer({reasons:[{code:'X',message:'leak '+TOKEN,remedy:null}]}))]});
  assert.ok(!asJson.out.includes(TOKEN));const outLines=asJson.lines.filter(l=>l.stream==='out');assert.equal(outLines.length,1);assert.equal(JSON.parse(outLines[0].line).gate_id,GATE);
  assert.equal(redact('a zgt_abc-_9 b zbg_x zdt_y zct_z'),'a zgt_[redacted] b zbg_[redacted] zdt_[redacted] zct_[redacted]');
  // The runner trims leading whitespace before parsing commands, so a space is not enough.
  for(const line of ['::set-output name=x::y','  ::error::x','\t::add-mask::x',' \t ##[group]x','##vso[task.setvariable]x','a\n  ::warning::b'])
    for(const out of redact(line).split('\n'))assert.ok(!/^\s*(::|##\[|##vso\[)/.test(out),JSON.stringify(out));
  assert.equal(redact('::set-output name=x::y'),'> ::set-output name=x::y');assert.equal(redact('fine :: here'),'fine :: here');
  // The v1 parser (IndexOf("##[")) and Azure's ##vso[ fire anywhere in a line, not only at the start.
  for(const line of ['Blocked by Zof: x ##[warning]y','reason ##vso[task.setvariable variable=x]1','a##[error]b ##vso[task.complete]'])
    assert.ok(!/##(vso)?\[/.test(redact(line)),redact(line));
  assert.equal(redact('x ##[warning]y'),'x # #[warning]y');assert.equal(redact('x ##vso[a]'),'x # #vso[a]');
});

test('GitHub Actions: masks the token first, and detects the PR head commit',async()=>{
  const env={...baseEnv,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'acme/app',GITHUB_SHA:'f'.repeat(40),GITHUB_REF:'refs/pull/7/merge',GITHUB_RUN_ID:'99',GITHUB_RUN_ATTEMPT:'2',GITHUB_JOB:'deploy',GITHUB_SERVER_URL:'https://github.com',GITHUB_EVENT_PATH:'/ev.json'};
  const r=await run({env,argv:['decide','--environment','Production'],files:{'/ev.json':JSON.stringify({pull_request:{number:7,head:{sha:SHA.toUpperCase()}}})},responses:[json(201,answer())]});
  assert.equal(r.code,EXIT.pass,r.out);assert.equal(r.lines[0].line,'::add-mask::'+TOKEN);
  assert.ok(!r.lines.slice(1).some(l=>l.line.includes(TOKEN)));
  const body=JSON.parse(r.requests[0].body);
  assert.deepEqual(body,{schema_version:1,repo:'acme/app',commit_sha:SHA,ref:'refs/pull/7/merge',pull_request:7,environment:'production',pipeline:{provider:'github_actions',run_id:'99',run_attempt:2,job:'deploy',run_url:'https://github.com/acme/app/actions/runs/99'}});
  assert.equal(r.requests[0].headers['idempotency-key'],'github_actions:99:2:deploy:production');
});

test('CI detection: GitHub push, GitLab needs --repo, flags override',async()=>{
  const gh=await detectCi({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'acme/app',GITHUB_SHA:SHA,GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_JOB:'deploy',GITHUB_SERVER_URL:'https://github.com'},async()=>{throw new Error('none');});
  assert.equal(gh.provider,'github_actions');assert.equal(gh.commit,SHA);assert.equal(gh.pullRequest,undefined);
  const glEnv={GITLAB_CI:'true',CI_PROJECT_PATH:'acme/app-mirror',CI_COMMIT_SHA:SHA,CI_COMMIT_REF_NAME:'main',CI_MERGE_REQUEST_IID:'3',CI_PIPELINE_ID:'500',CI_JOB_ID:'9001',CI_JOB_NAME:'deploy',CI_JOB_URL:'https://gitlab.example.test/acme/app/-/jobs/9001',CI_ENVIRONMENT_NAME:'staging'};
  const gl=await detectCi(glEnv,async()=>'');
  assert.equal(gl.provider,'gitlab_ci');assert.equal(gl.repo,undefined);assert.equal(gl.environment,'staging');assert.equal(gl.pullRequest,undefined);assert.equal(gl.runAttempt,9001);
  const missing=await run({env:{...baseEnv,...glEnv},argv:['decide'],responses:[json(201,answer())]});assert.equal(missing.code,EXIT.config);assert.match(missing.out,/--repo/);
  const ok=await run({env:{...baseEnv,...glEnv},argv:['decide','--repo','acme/app'],responses:[json(201,answer({environment:'staging',policy_environment:'staging'}))]});
  assert.equal(ok.code,EXIT.pass,ok.out);const body=JSON.parse(ok.requests[0].body);assert.equal(body.environment,'staging');assert.equal(body.pipeline.provider,'gitlab_ci');assert.equal(body.pipeline.run_url,glEnv.CI_JOB_URL);
});

test('parseAnswer rejects a pass for another gate id on a poll',()=>{
  const ok=parseAnswer(JSON.stringify(answer()),{repo:'acme/app',commit_sha:SHA,environment:'production',gate_id:GATE});assert.equal(ok.ok,true);
  const other=parseAnswer(JSON.stringify(answer()),{repo:'acme/app',commit_sha:SHA,environment:'production',gate_id:'gate_'+'f'.repeat(32)});assert.equal(other.ok,false);
});

test('the zof CLI dispatches gate decide through the thin adapter, with no network',async()=>{
  const {spawnSync}=await import('node:child_process');const {resolve}=await import('node:path');
  const env={...process.env};delete env.ZOF_GATE_TOKEN;delete env.GITHUB_ACTIONS;delete env.GITLAB_CI;
  const r=spawnSync(process.execPath,[resolve('dist/cli.js'),'gate','decide','--environment','production'],{encoding:'utf8',env,timeout:10000});
  assert.equal(r.status,EXIT.config);assert.match(r.stdout,/ZOF_GATE_TOKEN is not set/);
  assert.equal(spawnSync(process.execPath,[resolve('dist/cli.js'),'gate','decide','--help'],{encoding:'utf8',env,timeout:10000}).status,EXIT.pass);
});

// Review round 1.
test('GitHub Actions with --json: the mask goes to stderr and stdout holds exactly one JSON line',async()=>{
  const env={...baseEnv,GITHUB_ACTIONS:'true'};
  const r=await run({env,argv:[...args,'--json'],responses:[json(201,answer())]});
  assert.equal(r.code,EXIT.pass);const out=r.lines.filter(l=>l.stream==='out');assert.equal(out.length,1);assert.equal(JSON.parse(out[0].line).gate_id,GATE);
  assert.deepEqual(r.lines[0],{stream:'err',line:'::add-mask::'+TOKEN});
});

test('4xx without a Zof code is a proxy or firewall: exit 3 with the status; 408 is retried; 401 stays 4; 404 stays per A',async()=>{
  for(const status of [400,403,405,418]){const r=await run({responses:[{status,headers:{'content-type':'text/html'},text:'<html>blocked</html>'}]});assert.equal(r.code,EXIT.unavailable,String(status));assert.match(r.out,new RegExp(`HTTP ${status}`));assert.match(r.out,/on Zof's side/);}
  const timeout=await run({responses:[json(408,{})]});assert.equal(timeout.code,EXIT.unavailable);assert.ok(timeout.requests.length>1,'408 retried');
  const recovered=await run({responses:[json(408,{}),json(201,answer())]});assert.equal(recovered.code,EXIT.pass);
  assert.equal((await run({responses:[{status:401,headers:{},text:''}]})).code,EXIT.token);
  assert.equal((await run({responses:[{status:404,headers:{},text:''}]})).code,EXIT.config);
  assert.equal((await run({responses:[json(403,fail('some_new_code'))]})).code,EXIT.token);
});

test('gate_id is pinned end to end: a pass for another gate on a poll is no answer',async()=>{
  const r=await run({responses:[json(202,waiting()),json(200,answer({gate_id:'gate_'+'b'.repeat(32)}))]});assert.equal(r.code,EXIT.unavailable);
});

test('Retry-After is capped at 60 s, and one past --max-wait exits 3 at once',async()=>{
  const capped=await run({responses:[json(503,fail('unavailable'),{'retry-after':'120'})]});assert.ok(capped.sleeps.length>0&&capped.sleeps.every(ms=>ms===60000),String(capped.sleeps));
  const late=await run({argv:[...args,'--max-wait','1'],responses:[(req,{advance})=>{advance(30000);return json(503,fail('unavailable'),{'retry-after':'45'});}]});
  assert.equal(late.code,EXIT.unavailable);assert.equal(late.requests.length,1);assert.deepEqual(late.sleeps,[]);
});

test('poll_after_seconds is clamped to 1-60 s',async()=>{
  for(const [poll,ms] of [[0,1000],[3600,60000],[-5,1000]]){const r=await run({responses:[json(202,waiting({poll_after_seconds:poll})),json(200,answer())]});assert.equal(r.code,EXIT.pass);assert.deepEqual(r.sleeps,[ms],String(poll));}
});

test('runner clock skew: the server deadline is read as wait_until - answered_at, not against the local clock',async()=>{
  const skewed=waiting({wait_until:'2020-01-01T00:10:00Z',answered_at:'2020-01-01T00:00:00Z'});
  const r=await run({responses:[json(202,skewed),json(200,skewed),json(200,answer())]});assert.equal(r.code,EXIT.pass,r.out);
});

test('help exits 0 only on its own; stray flags and a missing subcommand exit 2',async()=>{
  for(const argv of [['--help'],['-h'],['help'],['decide','--help']])assert.equal((await run({argv})).code,EXIT.pass,argv.join(' '));
  const mixed=await run({argv:[...args,'--help'],responses:[json(201,answer())]});assert.equal(mixed.code,EXIT.config);assert.equal(mixed.requests.length,0);
  const bare=await run({argv:['--environment','x'],responses:[json(201,answer())]});assert.equal(bare.code,EXIT.config);assert.match(bare.out,/Unknown subcommand\. Use: zof gate decide --environment <name>/);
  assert.equal((await run({argv:[]})).code,EXIT.config);
});

test('repo matches case-insensitively; commit and environment stay exact',async()=>{
  assert.equal((await run({responses:[json(201,answer({repo:'ACME/App'}))]})).code,EXIT.pass);
  assert.equal((await run({responses:[json(201,answer({environment:'Production'}))]})).code,EXIT.unavailable);
});

test('polish: reasons_total type-checked, --json errors are one line, clear next steps',async()=>{
  assert.equal((await run({responses:[json(201,answer({reasons_total:'lots'}))]})).code,EXIT.unavailable);
  for(const [responses,env,exit] of [[[json(422,fail('unknown_environment'))],baseEnv,2],[[new Error('down')],baseEnv,3],[[json(401,fail('unauthorized'))],baseEnv,4],[[],{ZOF_API_URL:API},2]]){
    const r=await run({env,argv:[...args,'--json'],responses});assert.equal(r.code,exit);const out=r.lines.filter(l=>l.stream==='out');assert.equal(out.length,1,r.out);
    const e=JSON.parse(out[0].line).error;assert.equal(e.exit,exit);assert.equal(typeof e.code,'string');
  }
  assert.match((await run({env:{ZOF_GATE_TOKEN:TOKEN}})).out,/Pipeline tokens/);
  assert.match((await run({argv:[...args,'--break-glass','x']})).out,/later release.*contact Zof support/);
});

test('production wiring uses a monotonic clock, not wall time',async()=>{
  const {productionDeps}=await import('../dist/gate/index.js');
  const d=productionDeps('0.0.0-test');const a=d.now(),b=d.now();
  // performance.now() counts from process start; Date.now() is ~1.7e12.
  assert.ok(a>=0&&a<1e10&&b>=a,String(a));
});
