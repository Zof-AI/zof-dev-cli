/** The planned test-run flow (`zof runs create --repo`, alias `zof run`) with the real process: network, terminal and Ctrl-C. */
import {spawn as nodeSpawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {fetchHttpClient} from '../gate/http.js';
import type {RunDeps, SignIn} from './common.js';
import type {Spawn} from './keychain.js';

export {runCommand, RUN_HELP} from './run.js';
export {loadStore, nativeStore, secretToolStore, type SecretStore, type Spawn} from './keychain.js';
export type {RunDeps, SignIn} from './common.js';

const MAX_STDOUT = 64 * 1024;

/** No shell, arguments as an array; a secret goes only through stdin. */
export const spawnProcess: Spawn = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = nodeSpawn(command, [...args], {shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true});
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_STDOUT) stdout += chunk.toString('utf8'); });
  child.on('error', reject);
  child.on('close', code => resolve({code, stdout}));
  child.stdin.end(options.stdin ?? '');
});

export function productionRunDeps(version: string, signIn: () => Promise<SignIn | null>): RunDeps {
  return {
    version,
    env: process.env,
    http: fetchHttpClient,
    spawn: spawnProcess,
    signIn,
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    uuid: () => randomUUID(),
    write: (stream, line) => { (stream === 'out' ? process.stdout : process.stderr).write(line + '\n'); },
    interactive: process.stdin.isTTY === true,
    ask: async question => {
      const rl = createInterface({input: process.stdin, output: process.stderr});
      try { return await rl.question(question); } catch { return null; } finally { rl.close(); }
    },
    onInterrupt: handler => {
      process.on('SIGINT', handler);
      return () => { process.removeListener('SIGINT', handler); };
    },
  };
}
