import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {gateCommand,parseAnswer,EXIT} from '../dist/gate/index.js';

// Contract tests against the CP-1 files vendored in tests/fixtures/release-gate (see its README).
const DIR='tests/fixtures/release-gate';
const load=name=>JSON.parse(readFileSync(join(DIR,name),'utf8'));
const answers=Object.fromEntries(readdirSync(DIR).filter(f=>f.startsWith('release-gate-answer-')).map(f=>[f.replace(/^release-gate-answer-|\.v1\.json$/g,''),load(f)]));
const requestSchema=load('release_gate_request.v1.json');
const openapi=load('gate.v1.json');

const TOKEN='zgt_'+'Q'.repeat(43);
const SHA='a'.repeat(40);
const env={ZOF_GATE_TOKEN:TOKEN,ZOF_API_URL:'https://cp.example.test'};
const args=['decide','--environment','prod-eu','--repo','example-org/shop','--commit',SHA,'--run-id','1234567890'];
const json=(status,body,headers={})=>({status,headers:{'content-type':'application/json',...headers},text:JSON.stringify(body)});

async function run({argv=args,environment=env,responses,files={}}){
  let t=0;const requests=[];const lines=[];const queue=[...responses];
  const http=async req=>{requests.push(req);const next=queue.length>1?queue.shift():queue[0];if(next instanceof Error)throw next;return next;};
  const code=await gateCommand(argv,{version:'0.0.0-test',env:environment,http,now:()=>t,sleep:async ms=>{t+=ms;},random:()=>0.5,readFile:async p=>{if(p in files)return files[p];throw new Error('ENOENT');},write:(stream,line)=>lines.push({stream,line})});
  return {code,requests,out:lines.map(l=>l.line).join('\n')};
}

/** A small JSON Schema check for the keywords the vendored request schema uses; anything else fails loudly. */
function validate(schema,value,root=schema,path='$'){
  const errors=[];const known=new Set(['$defs','$id','$schema','$ref','title','description','default','type','const','enum','pattern','minLength','maxLength','minimum','maximum','properties','required','additionalProperties','anyOf','items','maxItems','format']);
  for(const k of Object.keys(schema))if(!known.has(k))errors.push(`${path}: unsupported keyword ${k}`);
  if(schema.$ref){const target=schema.$ref.replace(/^#\/(\$defs|components\/schemas)\//,'');return validate((root.$defs??root.components.schemas)[target],value,root,path);}
  if(schema.anyOf){const ok=schema.anyOf.some(s=>validate(s,value,root,path).length===0);return ok?errors:[...errors,`${path}: matches no anyOf branch`];}
  const type=value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
  if(schema.type&&!(schema.type===type||(schema.type==='number'&&type==='integer')))return [...errors,`${path}: expected ${schema.type}, got ${type}`];
  if('const' in schema&&value!==schema.const)errors.push(`${path}: expected const ${schema.const}`);
  if(schema.enum&&!schema.enum.includes(value))errors.push(`${path}: ${value} not in enum`);
  if(typeof value==='string'){if(schema.pattern&&!new RegExp(schema.pattern,'u').test(value))errors.push(`${path}: ${value} fails ${schema.pattern}`);if(schema.minLength!==undefined&&value.length<schema.minLength)errors.push(`${path}: too short`);if(schema.maxLength!==undefined&&value.length>schema.maxLength)errors.push(`${path}: too long`);}
  if(typeof value==='number'){if(schema.minimum!==undefined&&value<schema.minimum)errors.push(`${path}: below minimum`);if(schema.maximum!==undefined&&value>schema.maximum)errors.push(`${path}: above maximum`);}
  if(type==='object'){
    for(const r of schema.required??[])if(!(r in value))errors.push(`${path}: missing ${r}`);
    for(const [k,v] of Object.entries(value)){const s=schema.properties?.[k];if(s)errors.push(...validate(s,v,root,`${path}.${k}`));else if(schema.additionalProperties===false)errors.push(`${path}: extra property ${k}`);}
  }
  return errors;
}

test('the validator accepts the CP request fixtures and rejects broken bodies',()=>{
  for(const f of ['release-gate-request.v1.json','release-gate-request-break-glass.v1.json'])assert.deepEqual(validate(requestSchema,load(f)),[],f);
  const good=load('release-gate-request.v1.json');
  for(const bad of [{...good,tenant_id:'x'},{...good,commit_sha:'ABC'},{...good,environment:'Prod'},{...good,pipeline:{...good.pipeline,provider:'travis'}},{...good,repo:'own_er/x'},(({repo,...r})=>r)(good)])
    assert.notDeepEqual(validate(requestSchema,bad),[],JSON.stringify(bad).slice(0,80));
});

test('every request the CLI builds validates against release_gate_request.v1.json',async()=>{
  const gh={...env,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'example-org/shop',GITHUB_SHA:'b'.repeat(40),GITHUB_REF:'refs/pull/42/merge',GITHUB_RUN_ID:'1234567890',GITHUB_RUN_ATTEMPT:'3',GITHUB_JOB:'deploy',GITHUB_SERVER_URL:'https://github.com',GITHUB_EVENT_PATH:'/ev.json'};
  const gl={...env,GITLAB_CI:'true',CI_COMMIT_SHA:SHA,CI_COMMIT_REF_NAME:'main',CI_PIPELINE_ID:'500',CI_JOB_ID:'9001',CI_JOB_NAME:'deploy prod',CI_JOB_URL:'https://gitlab.example.test/x/-/jobs/9001',CI_ENVIRONMENT_NAME:'prod-eu'};
  const cases=[
    {argv:args},
    {argv:[...args,'--pr','42','--ref','refs/heads/main','--run-url','https://ci.example.test/run/1']},
    {argv:['decide','--environment','prod-eu'],environment:gh,files:{'/ev.json':JSON.stringify({pull_request:{number:42,head:{sha:SHA}}})}},
    {argv:['decide','--environment','prod-eu','--repo','example-org/shop'],environment:gl},
  ];
  for(const c of cases){
    const r=await run({...c,responses:[json(201,answers.pass)]});
    assert.equal(r.requests.length,1,r.out);const body=JSON.parse(r.requests[0].body);
    assert.deepEqual(validate(requestSchema,body),[],JSON.stringify(body));
    assert.match(r.requests[0].headers['idempotency-key'],/^[\x21-\x7e]{1,200}$/);
  }
});

test('a repo the contract would refuse is caught locally with exit 2, and nothing is sent',async()=>{
  for(const repo of ['own_er/shop','own.er/shop','o'.repeat(40)+'/shop']){
    const r=await run({argv:['decide','--environment','prod-eu','--repo',repo,'--commit',SHA,'--run-id','1'],responses:[json(201,answers.pass)]});
    assert.equal(r.code,EXIT.config,repo);assert.equal(r.requests.length,0,repo);
  }
});

test('every CP answer fixture parses and maps to its exit code',async()=>{
  const expected={pass:EXIT.pass,'pass-baseline':EXIT.pass,fail:EXIT.blocked,expired:EXIT.blocked,
    // This client never sends break-glass (G-4), so a break-glass pass it did not ask for is not trusted.
    'pass-break-glass':EXIT.unavailable};
  assert.deepEqual(Object.keys(answers).sort(),[...Object.keys(expected),'waiting'].sort(),'a new CP fixture needs an expected exit here');
  const expect={repo:'example-org/shop',commit_sha:SHA,environment:'prod-eu'};
  for(const [name,answer] of Object.entries(answers)){
    const parsed=parseAnswer(JSON.stringify(answer),{...expect,breakGlass:name==='pass-break-glass'});assert.equal(parsed.ok,true,`${name}: ${parsed.why}`);
    if(name==='waiting')continue;
    const r=await run({responses:[json(201,answer)]});assert.equal(r.code,expected[name],`${name}: ${r.out}`);
  }
  const waitingOnce=await run({argv:[...args,'--no-wait'],responses:[json(202,answers.waiting)]});assert.equal(waitingOnce.code,EXIT.blocked);
  const waitingThenPass=await run({responses:[json(202,answers.waiting),json(200,answers.pass)]});assert.equal(waitingThenPass.code,EXIT.pass);
  assert.equal(waitingThenPass.requests[1].url,`https://cp.example.test/v1/gate/checks/${answers.waiting.gate_id}?wait=20`);
});

test('a final answer for another environment, repo, commit or gate is no answer (exit 3)',async()=>{
  for(const name of ['pass','pass-baseline','fail','expired']){
    for(const over of [{environment:'staging'},{environment:'prod-us'},{commit_sha:'b'.repeat(40)},{repo:'example-org/other'}]){
      const r=await run({responses:[json(201,{...answers[name],...over})]});assert.equal(r.code,EXIT.unavailable,`${name} ${JSON.stringify(over)}`);
    }
  }
  const otherGate=await run({responses:[json(202,answers.waiting),json(200,{...answers.pass,gate_id:'gate_'+'2'.repeat(32)})]});assert.equal(otherGate.code,EXIT.unavailable);
});

test('every GateErrorCode in gate.v1 maps to the exit CP-1 encodes',async()=>{
  // CP-1 backend/src/zof_control/gate/errors.py GATE_ERRORS: status and CLI exit per code.
  const table={unauthorized:[401,4],token_expired:[401,4],insufficient_scope:[403,4],gate_not_enabled:[403,4],company_unbound:[403,4],environment_not_allowed:[403,4],break_glass_not_allowed:[403,4],repo_not_found:[404,2],not_found:[404,2],commit_unknown:[409,1],commit_ambiguous:[409,2],idempotency_conflict:[409,2],payload_too_large:[413,2],idempotency_key_required:[422,2],invalid_body:[422,2],unknown_environment:[422,2],rate_limited:[429,3],unavailable:[503,3],policy_lagging:[503,3],verification_unavailable:[503,3]};
  assert.deepEqual([...openapi.components.schemas.GateErrorCode.enum].sort(),Object.keys(table).sort(),'gate.v1 error codes changed');
  for(const [code,[status,exit]] of Object.entries(table)){
    const r=await run({responses:[json(status,{code,detail:'Synthetic detail.'},status>=429?{'retry-after':'1'}:{})]});assert.equal(r.code,exit,code);
  }
  // A 404 on a gate_id this CLI just created is Zof's side (exit_code(polling_own_call=True)).
  const lost=await run({responses:[json(202,answers.waiting),json(404,{code:'not_found',detail:'x'})]});assert.equal(lost.code,EXIT.unavailable);
});

test('the long-poll wait parameter stays inside gate.v1 bounds',async()=>{
  const wait=openapi.paths['/v1/gate/checks/{gate_id}'].get.parameters.find(p=>p.name==='wait').schema;
  const r=await run({responses:[json(202,answers.waiting),json(200,answers.waiting),json(200,answers.pass)]});
  for(const q of r.requests.slice(1)){const w=Number(new URL(q.url).searchParams.get('wait'));assert.ok(Number.isInteger(w)&&w>=wait.minimum&&w<=wait.maximum,q.url);}
});

test('a CI job name over the contract 100 characters is a config error naming the field (exit 2)',async()=>{
  const gh={...env,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'example-org/shop',GITHUB_SHA:SHA,GITHUB_RUN_ID:'1',GITHUB_JOB:'j'.repeat(101)};
  const r=await run({argv:['decide','--environment','prod-eu'],environment:gh,responses:[json(201,answers.pass)]});
  assert.equal(r.code,EXIT.config);assert.equal(r.requests.length,0);assert.match(r.out,/job name/i);assert.match(r.out,/100/);
  const repo=await run({argv:['decide','--environment','prod-eu','--repo','own_er/shop','--commit',SHA,'--run-id','1'],responses:[json(201,answers.pass)]});
  assert.match(repo.out,/--repo/);assert.match(repo.out,/39/);
});

test('answers are held to release_gate.v1: missing required fields or a non-UUID authorization_id exit 3',async()=>{
  const drop=(o,k)=>{const c={...o};delete c[k];return c;};
  for(const bad of [drop(answers.pass,'tenant_id'),drop(answers.pass,'correlation_id'),drop(answers.pass,'answered_at'),drop(answers.pass,'policy_environment'),
    {...answers.pass,policy_environment:'prod-eu'},{...answers.pass,answered_at:'yesterday'},{...answers.pass,tenant_id:7},{...answers.pass,authorization_id:'auth_1'},{...answers.pass,authorization_id:''}]){
    const r=await run({responses:[json(201,bad)]});assert.equal(r.code,EXIT.unavailable,JSON.stringify(bad).slice(0,160));
  }
});
