#!/usr/bin/env node
import {resolve} from 'node:path';
import {safeReadJson,safeReadFile,redact,serializeEvidence} from '@zofai/evidence-spec';
import {formatReport as formatImpact} from '@zofai/change-impact';
import {formatReport as formatPolicy} from '@zofai/policy-as-code';
import {VERSION,init,verify,analyzeImpact,runTests,readEvidence,evaluatePolicy,doctor,formatVerification,compareContracts,readContract,compareSchemas,readSchema,analyzeRisk,selectTests,generateTests,readSource,normalizeReport} from './index.js';
const help=`Zof local verification CLI ${VERSION}\nCommands: init, verify, diff, impact, test, evidence, policy, doctor, version, help\nAdditional modules: contract, schema, risk, select-tests, suggest-tests\ncontract/schema: --baseline FILE --candidate FILE [--format openapi|json-schema]\nsuggest-tests: --input CONFIG.json; evidence: --input REPORT --format junit|json|static-json\nOptions: --root DIR --base REF --head REF --changed PATH (repeatable) --json\nverify/evidence: --fail-on info|low|medium|high|critical\ntest: --allow-exec (executes only explicitly configured trusted argv commands)\nevidence: --input FILE (validate/redact existing evidence)\npolicy: --policy FILE --evidence FILE [--now ISO]\nExit 0 = success, 1 = finding/failure, 2 = invalid/missing/incomplete. No hosted uploads.`;
export async function main(args:string[]):Promise<number>{
  const command=args.shift()??'help';
  if(command==='help'||command==='--help'||args.includes('--help')){console.log(help);return 0;}
  if(command==='version'||command==='--version'){console.log(VERSION);return 0;}
  let root=process.cwd();let json=false;let allowExecution=false;let base:string|undefined;let head:string|undefined;let failOn:any;let input:string|undefined;let policyPath:string|undefined;let evidencePath:string|undefined;let now:string|undefined;let changedFiles:string[]|undefined;let baseline:string|undefined;let candidate:string|undefined;let format:string|undefined;
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(flag==='--json'){json=true;continue;}if(flag==='--allow-exec'){allowExecution=true;continue;}
    const value=args[++i];if(!value)throw new Error('MISSING_OPTION');
    switch(flag){case '--root':root=resolve(value);break;case '--base':base=value;break;case '--head':head=value;break;case '--fail-on':failOn=value;break;case '--changed':(changedFiles??=[]).push(value);break;case '--input':input=value;break;case '--policy':policyPath=value;break;case '--evidence':evidencePath=value;break;case '--now':now=value;break;case '--baseline':baseline=value;break;case '--candidate':candidate=value;break;case '--format':format=value;break;default:throw new Error('UNKNOWN_OPTION');}
  }
  const print=(value:unknown,text?:string)=>console.log(json||!text?JSON.stringify(redact(value),null,2):text);
  const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
    switch(command){
      case 'init':{const c=await init(root);print(c,'Created zof.config.json. Configure trusted test commands before explicit execution.');return 0;}
      case 'doctor':{const d=await doctor();print(d);return d.git&&d.nodeSupported?0:2;}
      case 'verify':{const r=await verify({root,base,head,changedFiles,failOn,signal:controller.signal});print(r,json?undefined:formatVerification(r));return r.exitCode;}
      case 'diff':case 'impact':{const r=await analyzeImpact({root,base,head,changedFiles});const out=command==='diff'?{changes:r.changes}:r;print(out,command==='diff'?r.changes.map(c=>`${c.status} ${c.path} +${c.addedLines} -${c.deletedLines}`).join('\n'):formatImpact(r));return 0;}
      case 'test':{const e=await runTests(root,{allowExecution,signal:controller.signal});console.log(serializeEvidence(e));return e.execution.result==='fail'?1:e.execution.result==='pass'?0:2;}
      case 'evidence':{if(input){if(format){if(!['junit','json','static-json'].includes(format))throw new Error('FORMAT');const e=normalizeReport(await safeReadFile(root,input),{format:format as 'junit'});console.log(serializeEvidence(e));return e.execution.result==='pass'?0:e.execution.result==='fail'?1:2;}console.log(serializeEvidence(await readEvidence(root,input)));return 0;}const r=await verify({root,base,head,changedFiles,failOn,signal:controller.signal});console.log(serializeEvidence(r.evidence));return r.exitCode;}
      case 'contract':{if(!baseline||!candidate)throw new Error('CONTRACT_INPUT');if(format&&!['openapi','json-schema'].includes(format))throw new Error('FORMAT');const [a,b]=await Promise.all([readContract(root,baseline),readContract(root,candidate)]);const r=compareContracts(a,b,{...(format?{kind:format as 'openapi'}:{}),...(failOn?{failOn}:{})});print(r);return r.compatible?0:1;}
      case 'schema':{if(!baseline||!candidate)throw new Error('SCHEMA_INPUT');const [a,b]=await Promise.all([readSchema(root,baseline),readSchema(root,candidate)]);const r=compareSchemas(a,b,failOn?{failOn}:{});print(r);return r.risky?1:0;}
      case 'risk':{print(await analyzeRisk({root,base,head,changedFiles}));return 0;}
      case 'select-tests':{const r=await selectTests({root,base,head,changedFiles});print(r);return r.mode==='blocked'?2:0;}
      case 'suggest-tests':{if(!input)throw new Error('GENERATION_INPUT');const c=await safeReadJson(root,input) as any;if(!c||typeof c.sourcePath!=='string')throw new Error('GENERATION_CONFIG');const {sourcePath,...generation}=c;print(generateTests({...generation,source:await readSource(root,sourcePath)}));return 0;}
      case 'policy':{if(!policyPath||!evidencePath)throw new Error('MISSING_POLICY_INPUT');const [p,e]=await Promise.all([safeReadJson(root,policyPath),safeReadJson(root,evidencePath)]);const r=evaluatePolicy(e,p,{now});print(r,formatPolicy(r));return r.result==='pass'?0:r.result==='fail'?1:2;}
      default:throw new Error('UNKNOWN_COMMAND');
    }
  }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(()=>{console.error('ZOF_INPUT_ERROR: check command, workspace, bounded relative paths and configuration; use zof help. No input details were logged.');process.exitCode=2;});
