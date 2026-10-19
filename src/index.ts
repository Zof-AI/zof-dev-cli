import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {open,realpath,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createEvidence,redact,safeReadFile,safeReadJson,serializeEvidence,validateEvidence,type Evidence,type Finding} from '@zof-ai/evidence-spec';
import {analyzeImpact,type ImpactReport} from '@zof-ai/change-impact';
export {analyzeImpact} from '@zof-ai/change-impact';
export {evaluatePolicy} from '@zof-ai/policy-as-code';
export {compareContracts,readContract} from '@zof-ai/api-contract-check';
export {compareSchemas,readSchema} from '@zof-ai/schema-diff';
export {analyzeRisk} from '@zof-ai/code-risk-score';
export {selectTests} from '@zof-ai/test-selection';
export {generateTests,readSource} from '@zof-ai/testgen';
export {normalizeReport} from '@zof-ai/ci-evidence';
export const VERSION='0.1.0';
export const CAPABILITIES={version:VERSION,local:['verify','diff','impact','test','evidence','policy'],hosted:{available:false,status:'DOCUMENTED_BUT_UNVERIFIED',reason:'Approved hosted acceptance and account capabilities have not been verified'},telemetry:false};
export interface Config {version:1;testCommands:{name:string;argv:string[];timeoutMs:number}[];exclude:string[]}
const defaultConfig:Config={version:1,testCommands:[],exclude:['node_modules','dist','.git']};
export async function init(root:string):Promise<Config>{
  const directory=await realpath(root);
  const file=await open(join(directory,'zof.config.json'),'wx',0o600);
  try{await file.writeFile(JSON.stringify(defaultConfig,null,2)+'\n');}finally{await file.close();}
  return structuredClone(defaultConfig);
}
export async function loadConfig(root:string):Promise<Config>{
  const x=await safeReadJson(root,'zof.config.json');
  if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('INVALID_CONFIG');
  const c=x as Config;
  if(Object.keys(c).some(k=>!['version','testCommands','exclude'].includes(k))||c.version!==1||!Array.isArray(c.exclude)||c.exclude.length>100||c.exclude.some(v=>typeof v!=='string'||v.length>256)||!Array.isArray(c.testCommands)||c.testCommands.length>20)throw new Error('INVALID_CONFIG');
  for(const command of c.testCommands){
    if(!command||typeof command!=='object'||Object.keys(command).some(k=>!['name','argv','timeoutMs'].includes(k))||typeof command.name!=='string'||command.name.length>128||!command.name.length||!Array.isArray(command.argv)||command.argv.length<1||command.argv.length>100||command.argv.some(v=>typeof v!=='string'||v.length>4096||v.includes('\0'))||!Number.isInteger(command.timeoutMs)||command.timeoutMs<1||command.timeoutMs>300000)throw new Error('INVALID_CONFIG');
  }
  return c;
}
const rules:{id:string;pattern:RegExp;message:string}[]=[
 {id:'dynamic-evaluation',pattern:/\b(?:eval|new\s+Function)\s*\(/g,message:'Dynamic code evaluation requires review; do not evaluate untrusted input.'},
 {id:'tls-verification-disabled',pattern:/rejectUnauthorized\s*:\s*false|verify\s*=\s*False/g,message:'TLS certificate verification is disabled.'},
 {id:'shell-execution',pattern:/shell\s*[:=]\s*(?:true|True)/g,message:'Shell execution is enabled; verify command arguments cannot contain untrusted data.'},
 {id:'credential-pattern',pattern:/(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,message:'A credential-shaped value was detected. Remove it and review exposure.'}
];
export interface VerifyOptions {root:string;base?:string;head?:string;changedFiles?:string[];exclude?:string[];failOn?:'info'|'low'|'medium'|'high'|'critical';signal?:AbortSignal}
export interface Verification {evidence:Evidence;impact:ImpactReport;exitCode:0|1|2}
/** Static inspection only. Does not execute repository code or claim tests passed. */
export async function verify(options:VerifyOptions):Promise<Verification>{
  if(options.signal?.aborted)throw new Error('CANCELLED');
  const threshold=options.failOn??'high';const levels=['info','low','medium','high','critical'];
  if(!levels.includes(threshold))throw new Error('INVALID_THRESHOLD');
  let exclude=options.exclude;
  if(!exclude){try{await lstat(join(options.root,'zof.config.json'));exclude=(await loadConfig(options.root)).exclude;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  const impact=await analyzeImpact({...options,exclude});
  if(impact.limitations.some(l=>l.code==='TREE_MISMATCH'))throw new Error('CHECKOUT_MISMATCH');
  const findings:Finding[]=[];let incomplete=false;
  for(const change of impact.changes){
    if(options.signal?.aborted)throw new Error('CANCELLED');
    if(change.status==='deleted')continue;
    if(!/\.(?:[cm]?[jt]sx?|py)$/.test(change.path)){
      if(!/\.(?:md|txt|json|ya?ml|lock|svg|png|jpg|css|html)$/.test(change.path))incomplete=true;
      continue;
    }
    const text=(await safeReadFile(options.root,change.path,2*1024*1024)).toString('utf8');
    for(const rule of rules){
      rule.pattern.lastIndex=0;let m:RegExpExecArray|null;
      while((m=rule.pattern.exec(text))!==null){
        const line=text.slice(0,m.index).split('\n').length;
        if(change.ranges.length && !change.ranges.some(r=>line>=r.start&&line<=r.end))continue;
        findings.push({id:rule.id,severity:rule.id==='credential-pattern'?'critical':'high',message:rule.message,path:change.path,line});
        if(findings.length>=1000)throw new Error('FINDING_LIMIT');
      }
    }
  }
  const fail=findings.some(f=>levels.indexOf(f.severity)>=levels.indexOf(threshold));
  let commit:string|null=null;
  if(!options.changedFiles&&(options.head||impact.changes.length===0)){
    try{const r=await promisify(execFile)('git',['-C',options.root,'rev-parse','--verify','--end-of-options',options.head??'HEAD'],{timeout:5000,maxBuffer:1024,env:gitEnvironment()});if(/^[0-9a-f]{40,64}\s*$/.test(r.stdout))commit=r.stdout.trim();}catch{/* unknown is explicit */}
  }
  const evidence=createEvidence({tool:{name:'zof-cli',version:VERSION},type:'static-analysis',source:{repository:null,commit},execution:{status:incomplete?'partial':'completed',result:fail?'fail':incomplete?'unknown':'pass'},findings,extensions:{'org.zof.static-analysis':{scope:'Documented heuristic patterns in changed lines; no tests executed',subject:options.head?'checked-out-commit':'working-tree',impactComplete:impact.complete}}});
  return {evidence,impact: redact(impact),exitCode:fail?1:incomplete?2:0};
}
function gitEnvironment():NodeJS.ProcessEnv{return {PATH:process.env.PATH,HOME:undefined,SystemRoot:process.env.SystemRoot,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'};}
export async function runTests(root:string,options:{allowExecution:boolean;signal?:AbortSignal}):Promise<Evidence>{
  if(!options.allowExecution)throw new Error('EXECUTION_NOT_AUTHORIZED');
  const config=await loadConfig(root);const tests:Evidence['tests']=[];
  let interrupted=false;
  for(const command of config.testCommands){
    if(options.signal?.aborted){interrupted=true;break;}
    const started=performance.now();
    const state=await new Promise<'passed'|'failed'|'error'>(resolve=>{
      const child=spawn(command.argv[0],command.argv.slice(1),{cwd:root,shell:false,stdio:'ignore',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,TMP:process.env.TMP},windowsHide:true,detached:process.platform!=='win32'});
      let killed=false;const stop=()=>{killed=true;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
      const timer=setTimeout(stop,command.timeoutMs);const cancel=()=>{interrupted=true;stop();};options.signal?.addEventListener('abort',cancel,{once:true});
      const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);};
      child.once('error',()=>{cleanup();resolve('error');});
      child.once('close',code=>{cleanup();resolve(killed?'error':code===0?'passed':'failed');});
    });
    tests.push({name:command.name,status:state,durationMs:Math.round(performance.now()-started)});
  }
  const failure=tests.some(t=>t.status==='failed'||t.status==='error');
  const incomplete=interrupted||tests.some(t=>t.status==='error');
  return createEvidence({tool:{name:'zof-cli',version:VERSION},type:'test-command-execution',execution:{status:tests.length===0?'missing':incomplete?'partial':'completed',result:failure?'fail':tests.length===0||incomplete?'unknown':'pass'},tests,extensions:{'org.zof.test-commands':{scope:'One observation per configured process, not per framework test case',logsCaptured:false}}});
}
export async function readEvidence(root:string,path:string):Promise<Evidence>{const e=await safeReadJson(root,path);if(!validateEvidence(e).valid)throw new Error('INVALID_EVIDENCE');return JSON.parse(serializeEvidence(e as Evidence));}
export async function doctor(){
  let git=false;try{await promisify(execFile)('git',['--version'],{timeout:3000,maxBuffer:1024,env:gitEnvironment()});git=true;}catch{}
  return {node:process.versions.node,nodeSupported:Number(process.versions.node.split('.')[0])>=22,git,...CAPABILITIES};
}
export function formatVerification(result:Verification):string{return [`Verification: ${result.evidence.execution.status}/${result.evidence.execution.result}`,...result.evidence.findings.map(f=>`${f.severity.toUpperCase()} ${f.id} ${f.path??''}:${f.line??''} ${f.message}`),'Static heuristics only; no tests were executed.'].join('\n');}
