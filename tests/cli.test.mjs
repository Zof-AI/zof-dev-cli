import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {init,loadConfig,verify,runTests,doctor,readEvidence} from '../dist/index.js';
const cli=resolve('dist/cli.js');
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'zof-cli-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const call=(root,args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',timeout:10000});
test('init refuses overwrite; config validates finite trusted commands',()=>fixture(async root=>{
 await init(root);assert.deepEqual((await loadConfig(root)).testCommands,[]);await assert.rejects(()=>init(root));
 await writeFile(join(root,'zof.config.json'),JSON.stringify({version:1,exclude:[],testCommands:[{name:'bad',argv:['node'],timeoutMs:999999999}]}));await assert.rejects(()=>loadConfig(root));
}));
test('safe and unsafe changes produce valid static evidence without source/log content',()=>fixture(async root=>{
 await writeFile(join(root,'safe.ts'),'export const sum=(a:number,b:number)=>a+b;\n');
 const clean=await verify({root,changedFiles:['safe.ts']});assert.equal(clean.exitCode,0);assert.equal(clean.evidence.type,'static-analysis');assert.equal(clean.evidence.tests.length,0);
 await writeFile(join(root,'unsafe.ts'),'export function run(input:string) { return eval(input); }\n');
 const bad=await verify({root,changedFiles:['unsafe.ts']});assert.equal(bad.exitCode,1);assert.equal(bad.evidence.findings[0].id,'dynamic-evaluation');assert.ok(!JSON.stringify(bad).includes('return eval(input)'));
 const relaxed=await verify({root,changedFiles:['unsafe.ts'],failOn:'critical'});assert.equal(relaxed.exitCode,0);assert.equal(relaxed.evidence.findings.length,1);
 await assert.rejects(()=>verify({root,changedFiles:['safe.ts'],failOn:'none'}));
}));
test('synthetic credential, unsafe TLS and shell signals have explainable severity',()=>fixture(async root=>{
 const synthetic='ghp_'+'a'.repeat(36);
 await writeFile(join(root,'unsafe.py'),`client(verify=False)\nsubprocess.run(command,shell=True)\ntoken="${synthetic}"\n`);
 const r=await verify({root,changedFiles:['unsafe.py']});assert.equal(r.exitCode,1);assert.equal(r.evidence.findings.length,3);assert.ok(!JSON.stringify(r).includes(synthetic));
}));
test('unsupported source is partial; traversal, symlinks and cancellation fail safely',()=>fixture(async root=>{
 await writeFile(join(root,'code.rs'),'fn main() {}');assert.equal((await verify({root,changedFiles:['code.rs']})).exitCode,2);
 await assert.rejects(()=>verify({root,changedFiles:['../outside.ts']}));
 await symlink(join(root,'code.rs'),join(root,'link.ts'));await assert.rejects(()=>verify({root,changedFiles:['link.ts']}));
 const controller=new AbortController();controller.abort();await assert.rejects(()=>verify({root,changedFiles:['code.rs'],signal:controller.signal}));
}));
test('test execution requires explicit opt-in; empty evidence never passes',()=>fixture(async root=>{
 await init(root);await assert.rejects(()=>runTests(root,{allowExecution:false}));const e=await runTests(root,{allowExecution:true});assert.equal(e.execution.status,'missing');assert.equal(e.execution.result,'unknown');
}));
test('test execution measures exit codes, strips arbitrary environment, kills timeout and omits raw logs',()=>fixture(async root=>{
 const config={version:1,exclude:[],testCommands:[{name:'pass',argv:[process.execPath,'-e','if(process.env.ZOF_TEST_SYNTHETIC_SECRET)process.exit(5); console.log("PRIVATE_TEST_LOG");'],timeoutMs:3000},{name:'fail',argv:[process.execPath,'-e','process.exit(1)'],timeoutMs:3000},{name:'timeout',argv:[process.execPath,'-e','setInterval(()=>{},1000)'],timeoutMs:50}]};
 await writeFile(join(root,'zof.config.json'),JSON.stringify(config));process.env.ZOF_TEST_SYNTHETIC_SECRET='not-a-real-secret';
 try{const e=await runTests(root,{allowExecution:true});assert.deepEqual(e.tests.map(t=>t.status),['passed','failed','error']);assert.equal(e.execution.status,'partial');assert.equal(e.execution.result,'fail');assert.ok(!JSON.stringify(e).includes('PRIVATE_TEST_LOG'));assert.ok(!JSON.stringify(e).includes('not-a-real-secret'));}finally{delete process.env.ZOF_TEST_SYNTHETIC_SECRET;}
}));
test('all ten documented commands execute end-to-end; errors do not echo malformed secrets',()=>fixture(async root=>{
 assert.equal(call(root,['init']).status,0);
 await writeFile(join(root,'main.ts'),'export const sum=(a:number,b:number)=>a+b;\n');
 for(const command of ['verify','diff','impact']){const r=call(root,[command,'--changed','main.ts','--json']);assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout));}
 const evidence=call(root,['evidence','--changed','main.ts']);assert.equal(evidence.status,0);await writeFile(join(root,'evidence.json'),evidence.stdout);assert.ok(await readEvidence(root,'evidence.json'));
 assert.equal(call(root,['evidence','--input','evidence.json']).status,0);
 await writeFile(join(root,'policy.json'),JSON.stringify({version:'1.0',rules:[{id:'findings',type:'deny-severity',severity:'high'}]}));
 assert.equal(call(root,['policy','--policy','policy.json','--evidence','evidence.json','--json']).status,0);
 assert.equal(call(root,['test']).status,2);assert.equal(call(root,['test','--allow-exec']).status,2);
 for(const command of ['doctor','version','help'])assert.equal(call(root,[command]).status,0);
 for(const args of [['bad'],['verify','--wat','x'],['verify','--changed'],['policy'],['evidence','--input','../secret']])assert.equal(call(root,args).status,2);
 await writeFile(join(root,'evidence.json'),'synthetic-secret-do-not-log');const invalid=call(root,['evidence','--input','evidence.json']);assert.equal(invalid.status,2);assert.ok(!invalid.stderr.includes('synthetic-secret'));
}));
test('actual Git diff analyzes only changed lines and does not execute Git external diff',()=>fixture(async root=>{
 const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r;};
 git('init','-b','main');git('config','user.name','Synthetic');git('config','user.email','synthetic@example.invalid');
 await writeFile(join(root,'main.ts'),'export const legacy=(x:string)=>eval(x);\nexport const number=1;\n');git('add','.');git('commit','-m','synthetic baseline');
 await writeFile(join(root,'main.ts'),'export const legacy=(x:string)=>eval(x);\nexport const number=2;\n');git('config','diff.external','not-an-executable-zof-test');
 const r=await verify({root});assert.equal(r.exitCode,0);assert.equal(r.evidence.source.commit,null);assert.equal(r.evidence.findings.length,0);
}));
