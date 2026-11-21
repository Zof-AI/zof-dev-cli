/** `zof login`, `zof logout` and `zof run` with the real process: keychain, network, terminal and Ctrl-C. */
import {spawn as nodeSpawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {fetchHttpClient} from '../gate/http.js';
import type {ExitCode} from '../gate/exit.js';
import type {RunDeps} from './common.js';
import {loadStore, type Spawn} from './keychain.js';
import {loginCommand, logoutCommand} from './login.js';
import {runCommand} from './run.js';

export {loginCommand, logoutCommand, LOGIN_HELP} from './login.js';
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

export function productionRunDeps(version: string): RunDeps {
  return {
    version,
    env: process.env,
    http: fetchHttpClient,
    spawn: spawnProcess,
    store: () => loadStore({platform: process.platform, spawn: spawnProcess, native: () => import('@napi-rs/keyring')}),
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

export function runSignedIn(command: 'login' | 'logout' | 'run', argv: string[], version: string): Promise<ExitCode> {
  const deps = productionRunDeps(version);
  return command === 'login' ? loginCommand(argv, deps) : command === 'logout' ? logoutCommand(argv, deps) : runCommand(argv, deps);
}
