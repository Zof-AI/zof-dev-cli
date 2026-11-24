/** Zof console commands (auth, review, copilot, runs, ...), ported from the console repo's apps/cli. Imports nothing from the local tools. */
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {homedir, hostname} from 'node:os';
import {ApiError} from './api.js';
import {parseArgs, UsageError} from './args.js';
import {AUTH} from './commands/auth.js';
import {CONFIG} from './commands/config.js';
import {COPILOT} from './commands/copilot.js';
import {EVENTS, RUNS_STREAM, SERVICES} from './commands/platform.js';
import {AGENTS, APPROVALS, ARTIFACTS, RUNS} from './commands/resources.js';
import {show as reviewShow, start as reviewStart} from './commands/review.js';
import {makeCtx, NotSignedIn, type Command, type ConsoleDeps} from './context.js';
import {errorLine, info} from './output.js';
import {loadStore} from '../run/keychain.js';
import {productionRunDeps, spawnProcess} from '../run/index.js';
import {RUN_HELP, runCommand} from '../run/run.js';

export {ApiClient, ApiError, consoleOrigin, stripControl} from './api.js';
export {parseArgs, UsageError} from './args.js';
export {DEFAULT_CONSOLE_URL, loadConfig, saveConfig} from './config.js';
export {findSignIn, saveSignIn, clearSignIn, FILE_NOTE} from './signin.js';
export {DEVICE_CLIENT_ID, authorizeBody, tokenBody} from './commands/auth.js';
export {DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S} from './commands/review.js';
export * from './copilot-turn.js';
export * from './review-render.js';
export * from './review-start.js';
export * from './review-url.js';
export * from './review-wait.js';
export * from './run-create-body.js';
export {readSse} from './sse.js';
export {formatDuration, formatJson} from './output.js';
export type {ConsoleDeps} from './context.js';

const TOPICS: Record<string, {summary: string; commands: Record<string, Command>}> = {
  auth: {summary: 'Sign in to the Zof console', commands: AUTH},
  config: {summary: 'Console CLI configuration (~/.zof/config.json)', commands: CONFIG},
  agents: {summary: 'Agent catalog and dispatch', commands: AGENTS},
  runs: {summary: 'Runs and their live activity', commands: {...RUNS, stream: RUNS_STREAM}},
  artifacts: {summary: 'Artifacts of an engine run', commands: ARTIFACTS},
  approvals: {summary: 'Remediation plan approvals', commands: APPROVALS},
  copilot: {summary: 'Ask Copilot (read-only from the CLI)', commands: COPILOT},
  review: {summary: 'Code reviews of GitHub pull requests', commands: {show: reviewShow}},
  services: {summary: 'Console health', commands: SERVICES},
  events: {summary: 'Live platform events', commands: EVENTS},
};

export const CONSOLE_TOPICS: ReadonlySet<string> = new Set([...Object.keys(TOPICS), 'login', 'logout', 'run']);

/** `zof login`/`zof logout` are `zof auth login`/`logout`; `zof run …` is `zof runs create …` and `zof run cancel` is `zof runs cancel`. */
export function resolveAlias(command: string, argv: string[]): [string, string[]] {
  if (command === 'login' || command === 'logout') return ['auth', [command, ...argv]];
  if (command === 'run') return argv[0] === 'cancel' ? ['runs', argv] : ['runs', ['create', ...argv]];
  return [command, argv];
}

const wantsTestRun = (argv: string[]) => argv.some(a => a === '--repo' || a.startsWith('--repo='));

export const CONSOLE_HELP = `Zof console commands (sign in with zof auth login, or set ZOF_TOKEN):
${Object.entries(TOPICS).map(([t, v]) => `  ${t.padEnd(10)} ${v.summary}`).join('\n')}
Aliases: zof login, zof logout, zof run (= zof runs create). Run zof <topic> --help for its commands. Env: ZOF_CONSOLE_URL (default https://console.zof.ai), ZOF_TOKEN, ZOF_ORG_ID, ZOF_ENV_ID, ZOF_OUTPUT, ZOF_NO_COLOR.
Exit 0 success, 1 failure or refusal, 2 usage.`;

const isHelp = (a: string | undefined) => a === '--help' || a === '-h' || a === 'help';

function topicHelp(topic: string): string {
  const t = TOPICS[topic];
  const lines = Object.values(t.commands).map(c => `  ${c.usage}\n      ${c.summary}`);
  if (topic === 'review') lines.unshift(`  ${reviewStart.usage}\n      ${reviewStart.summary}`);
  return `zof ${topic}: ${t.summary}\n${lines.join('\n')}`;
}

/** Runs one console command; every failure ends in a message and an exit code, never a stack trace. */
export async function consoleCommand(topic: string, argv: string[], deps: ConsoleDeps): Promise<number> {
  const t = TOPICS[topic];
  const write = (line: string) => deps.write('err', line);
  if (!t) { write(`Unknown command ${topic.slice(0, 40)}. Run zof help.`); return 2; }
  let command: Command | undefined;
  let rest = argv;
  if (topic === 'review' && argv[0] !== 'show' && !isHelp(argv[0]) && argv[0] !== undefined) command = reviewStart;
  else { command = argv[0] === undefined || isHelp(argv[0]) ? undefined : t.commands[argv[0]]; rest = argv.slice(1); }
  if (!command) {
    const asked = argv[0] === undefined || isHelp(argv[0]);
    (asked ? (l: string) => deps.write('out', l) : write)(asked ? topicHelp(topic) : `Unknown command zof ${topic} ${argv[0].slice(0, 40)}.\n${topicHelp(topic)}`);
    return asked ? 0 : 2;
  }

  const testRunHelp = topic === 'runs' && argv[0] === 'create' ? `\n\nOr plan, confirm and follow a test run (exit codes 0-4 as below):\n${RUN_HELP}` : '';
  if (rest.some(a => a === '--help' || a === '-h')) { deps.write('out', `${command.usage}\n  ${command.summary}${testRunHelp}`); return 0; }
  const json = rest.includes('--json');
  const ctx = makeCtx(deps, json);
  // The planned test-run flow keeps its own parser and exit codes; it shares only the sign-in.
  if (topic === 'runs' && argv[0] === 'create' && wantsTestRun(rest)) return deps.testRun(rest, ctx.signIn);
  if (topic === 'runs' && argv[0] === 'cancel' && /^mrun_/i.test(rest[0] ?? '')) return deps.testRun(['cancel', ...rest], ctx.signIn);
  try {
    const parsed = parseArgs(rest.filter(a => a !== '--json'), command.flags ?? {}, command.args?.length ?? 0);
    return await command.run(ctx, parsed);
  } catch (error) {
    if (error instanceof UsageError) { errorLine(ctx.o, error.message); info(ctx.o, `Usage: ${command.usage}`); return 2; }
    if (error instanceof NotSignedIn) { errorLine(ctx.o, error.message); return 1; }
    if (error instanceof ApiError) {
      const prefix = error.statusCode === 404 ? 'Not found: ' : ![0, 401, 402, 403].includes(error.statusCode) ? `Error (${error.statusCode}): ` : '';
      errorLine(ctx.o, `${prefix}${error.message}`);
      if (error.statusCode === 401) info(ctx.o, 'Run `zof auth login` to authenticate.');
      if (error.statusCode === 402) info(ctx.o, 'Visit the console to upgrade your plan.');
      if (error.requestId && ![0, 401, 402, 403, 404].includes(error.statusCode)) info(ctx.o, `Request ID: ${error.requestId}`);
      return 1;
    }

    errorLine(ctx.o, error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ') : 'An unexpected error occurred');
    return 1;
  }
}

/** Opens the sign-in page with the platform opener (argv, never a shell); false when there is none. */
function openUrl(url: string): Promise<boolean> {
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!bin || !/^https?:\/\//.test(url)) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      const child = spawn(bin, [url], {stdio: 'ignore', detached: true});
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

export function productionDeps(version: string): ConsoleDeps {
  let store: ReturnType<ConsoleDeps['store']> | undefined;
  return {
    store: () => (store ??= loadStore({platform: process.platform, spawn: spawnProcess, native: () => import('@napi-rs/keyring')})),
    testRun: (argv, signIn) => runCommand(argv, productionRunDeps(version, signIn)),
    version, env: process.env, home: homedir(), fetch: globalThis.fetch,
    write: (stream, line) => { (stream === 'out' ? process.stdout : process.stderr).write(line + '\n'); },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(), uuid: randomUUID, hostname, platform: process.platform,
    isTty: Boolean(process.stdout.isTTY), openUrl,
    writeFile: (path, content) => writeFileSync(path, content),
    input: process.stdin, output: process.stdout,
    onInterrupt: handler => { process.on('SIGINT', handler); return () => { process.removeListener('SIGINT', handler); }; },
  };
}

export function runConsole(command: string, argv: string[], version: string): Promise<number> {
  const [topic, rest] = resolveAlias(command, argv);
  return consoleCommand(topic, rest, productionDeps(version));
}
