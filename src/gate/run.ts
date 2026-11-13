import {parseAnswer, type Expect} from './answer.js';
import {detectCi, type Env, type ReadFile} from './ci.js';
import {EXIT, SIDE, refusal, type ExitCode} from './exit.js';
import type {HttpClient, HttpResponse} from './http.js';
import {redact} from './redact.js';
import {PROVIDERS, type GateAnswer, type GateRequest} from './types.js';

export interface GateDeps {
  version: string;
  env: Env;
  http: HttpClient;
  now: () => number; // monotonic milliseconds (performance.now in production)
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  readFile: ReadFile;
  write: (stream: 'out' | 'err', line: string) => void;
}

export const DEFAULT_MAX_WAIT_MINUTES = 10;
const MAX_WAIT_MINUTES = 60; // the action's 1 h ACTION_TTL caps every wait (spec 3.5)
const MAX_ATTEMPTS = 5; // consecutive failed tries before "Zof unavailable"
const LONG_POLL_SECONDS = 20;
const SERVER_GRACE_MS = 60_000; // past wait_until the server must answer final; if not, the fault is Zof's
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/; // release_gate_request.v1
const JOB = /^[\x21-\x7e]{1,100}$/;
const TOKEN = /^zgt_[A-Za-z0-9_-]{20,200}$/;
const PRINTABLE = /^[\x21-\x7e]{1,128}$/;
const SETTINGS_URL = 'Use the URL shown in Zof under Settings > Pipeline tokens.';
const UNAVAILABLE_NEXT = 'Re-run the job in a few minutes. If it keeps failing, contact Zof support.';

export const GATE_HELP = `zof gate decide: ask Zof whether this commit may deploy to an environment.
Options: --environment NAME (required unless the CI sets one) --repo OWNER/NAME --commit SHA --ref REF --pr N
         --run-id ID --run-url URL --max-wait MINUTES (default ${DEFAULT_MAX_WAIT_MINUTES}, at most ${MAX_WAIT_MINUTES}) --no-wait --json --api-url URL
Env: ZOF_GATE_TOKEN (required: your pipeline token, set as a CI secret), ZOF_API_URL.
Exit 0 pass, 1 blocked, 2 pipeline configuration, 3 Zof unavailable (never a pass), 4 pipeline token.`;

const ERROR_CODES: Record<ExitCode, string> = {0: 'pass', 1: 'blocked', 2: 'invalid_configuration', 3: 'unavailable', 4: 'token_problem'};
/** A stop: one line for what happened, one for what to do next. `code` is for --json only, never the log. */
class Stop extends Error {
  constructor(readonly exit: ExitCode, readonly what: string, readonly next: string, readonly code: string = ERROR_CODES[exit]) { super(what); }
}
const usage = (what: string, next: string) => new Stop(EXIT.config, what, next);
const unavailable = (what: string, code?: string) => new Stop(EXIT.unavailable, `${what} The gate never passes without one.`, UNAVAILABLE_NEXT, code);

interface Options {environment?: string; repo?: string; commit?: string; ref?: string; pr?: string; runId?: string; runUrl?: string; maxWait?: string; apiUrl?: string; noWait: boolean; json: boolean; help: boolean}
const VALUE_FLAGS: Record<string, keyof Options> = {'--environment': 'environment', '--repo': 'repo', '--commit': 'commit', '--ref': 'ref', '--pr': 'pr', '--run-id': 'runId', '--run-url': 'runUrl', '--max-wait': 'maxWait', '--api-url': 'apiUrl'};

function parseArgs(argv: string[]): Options {
  const o: Options = {noWait: false, json: false, help: false};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith('--') && argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    if (flag === '--no-wait') { o.noWait = true; continue; }
    if (flag === '--json') { o.json = true; continue; }
    if (flag === '--help' || flag === '-h') { o.help = true; continue; }
    if (flag === '--break-glass') throw usage('--break-glass comes in a later release.', 'Until then, contact Zof support.');
    const key = VALUE_FLAGS[flag];
    if (!key) throw usage(`Unknown option ${flag.slice(0, 40)}.`, 'Run zof gate decide --help.');
    const value = inline ?? argv[++i];
    if (value === undefined || value === '') throw usage(`${flag} needs a value.`, 'Run zof gate decide --help.');
    (o as unknown as Record<string, string>)[key] = value;
  }
  return o;
}

function apiBase(raw: string | undefined): string {
  if (!raw) throw usage('ZOF_API_URL is not set.', `Set it, or pass --api-url. ${SETTINGS_URL}`);
  let url: URL;
  try { url = new URL(raw); } catch { throw usage("ZOF_API_URL isn't a valid URL.", SETTINGS_URL); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw usage('ZOF_API_URL must use https.', SETTINGS_URL);
  if (url.username || url.password || url.search || url.hash) throw usage('ZOF_API_URL must not include a user, password, query or fragment.', SETTINGS_URL);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

async function buildRequest(o: Options, deps: GateDeps): Promise<{request: GateRequest; label: string}> {
  const ci = await detectCi(deps.env, deps.readFile);
  const environment = (o.environment ?? ci.environment)?.trim().toLowerCase();
  if (!environment) throw usage('No environment given.', 'Pass --environment, for example --environment production.');
  if (!NAME.test(environment)) throw usage('--environment must be lower-case letters, digits and dashes, starting with a letter.', 'For example: --environment prod-eu.');
  const repo = o.repo ?? ci.repo;
  if (!repo) throw usage('No repository given.', 'Pass --repo owner/name.');
  if (!REPO.test(repo)) throw usage('--repo must be owner/name.', 'Use the GitHub repository. The owner has 1-39 letters, digits or dashes.');
  const commit = (o.commit ?? ci.commit)?.toLowerCase();
  if (!commit) throw usage('No commit given.', 'Pass --commit with the full 40-character SHA.');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw usage("--commit isn't a full 40-character SHA.", 'Pass the full SHA, for example from git rev-parse HEAD.');
  const runId = o.runId ?? ci.runId;
  if (!runId) throw usage('No CI run id found.', 'Pass --run-id with your CI run or build id.');
  if (!PRINTABLE.test(runId)) throw usage('--run-id must be 1-128 characters with no spaces.', "Pass your CI's run or build id.");
  const ref = o.ref ?? ci.ref;
  if (ref !== undefined && (ref.length > 255 || !/^[\x20-\x7e]+$/.test(ref))) throw usage('--ref is too long or has unsupported characters.', 'Use at most 255 plain ASCII characters, or leave it out.');
  let pullRequest = ci.pullRequest;
  if (o.pr !== undefined) {
    if (!/^[1-9][0-9]{0,9}$/.test(o.pr)) throw usage('--pr must be a pull request number.', 'For example: --pr 42.');
    pullRequest = Number(o.pr);
  }
  const runUrl = o.runUrl ?? ci.runUrl;
  if (runUrl !== undefined && (!/^https:\/\/[\x21-\x7e]+$/.test(runUrl) || runUrl.length > 2048)) throw usage('--run-url must be an https URL of up to 2048 characters.', 'Fix it, or leave it out.');
  if (ci.job && ci.job.length > 100) throw usage('The CI job name is over 100 characters.', 'Shorten the job name (GITHUB_JOB or CI_JOB_NAME).');
  // A job name with spaces or other characters the contract refuses (common on GitLab) is sent as "gate", as in G-1.
  const job = ci.job && JOB.test(ci.job) ? ci.job : 'gate';
  if (!PROVIDERS.includes(ci.provider)) throw usage("This CI isn't supported.", 'Contact Zof support.');
  const request: GateRequest = {schema_version: 1, repo, commit_sha: commit, ...(ref ? {ref} : {}), ...(pullRequest ? {pull_request: pullRequest} : {}), environment,
    pipeline: {provider: ci.provider, run_id: runId, run_attempt: ci.runAttempt ?? 1, job, ...(runUrl ? {run_url: runUrl} : {})}};
  return {request, label: `${ci.label} run ${runId}`};
}

function maxWaitMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_WAIT_MINUTES * 60_000;
  if (!/^[0-9]{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_WAIT_MINUTES) throw usage(`--max-wait must be whole minutes from 1 to ${MAX_WAIT_MINUTES}.`, 'For example: --max-wait 30.');
  return Number(raw) * 60_000;
}

const header = (h: Record<string, string>, name: string) => h[name] ?? h[name.toLowerCase()];
function retryAfterMs(h: Record<string, string>): number | undefined {
  const v = header(h, 'retry-after');
  return v && /^[0-9]{1,4}$/.test(v.trim()) ? Math.min(Number(v.trim()), 60) * 1000 : undefined;
}
function errorCode(text: string): string | undefined {
  try { const v = JSON.parse(text) as {code?: unknown}; return typeof v.code === 'string' ? v.code.slice(0, 64) : undefined; } catch { return undefined; }
}

/** `zof gate decide`. Returns the exit code; fails closed on every path that is not a verifiable pass. */
export async function gateCommand(argv: string[], deps: GateDeps): Promise<ExitCode> {
  const args = argv[0] === 'decide' ? argv.slice(1) : argv;
  const token = (deps.env.ZOF_GATE_TOKEN ?? '').trim();
  const secrets = token ? [token] : [];
  let json = false;
  const say = (line: string) => deps.write(json ? 'err' : 'out', redact(line, secrets));
  const stop = (error: Stop): ExitCode => {
    say(`${SIDE[error.exit as keyof typeof SIDE] ?? 'Zof gate'}: ${error.what}`);
    say(`Next: ${error.next}`);
    if (json) deps.write('out', JSON.stringify({error: {code: redact(error.code, secrets), exit: error.exit}}));
    return error.exit;
  };
  // Help exits 0 only when it is the only argument.
  const helpOnly = (a: string[]) => a.length === 1 && ['--help', '-h', 'help'].includes(a[0]);
  if (helpOnly(argv) || helpOnly(args)) { deps.write('out', GATE_HELP); return EXIT.pass; }
  if (argv.length === 0) { deps.write('out', GATE_HELP); return EXIT.config; }
  if (argv[0] !== 'decide') return stop(usage('Unknown subcommand.', 'Use zof gate decide --environment <name>.'));
  // GitHub masks the value in every later log line. stderr keeps stdout to one JSON line under --json.
  // Only a well-formed single-line token is echoed into the mask; a malformed one is refused below (exit 4) and never printed.
  if (TOKEN.test(token) && deps.env.GITHUB_ACTIONS === 'true') deps.write('err', `::add-mask::${token}`);
  try {
    const o = parseArgs(args);
    json = o.json;
    if (o.help) throw usage("--help can't be combined with other options.", 'Run zof gate decide --help on its own.');
    if (!token) throw usage('ZOF_GATE_TOKEN is not set.', 'Add your pipeline token as a CI secret named ZOF_GATE_TOKEN.');
    if (!TOKEN.test(token)) throw new Stop(EXIT.token, "ZOF_GATE_TOKEN isn't a Zof pipeline token (those start with zgt_).", 'Copy the token from Zof (Settings > Pipeline tokens) into the CI secret.');
    const base = apiBase(o.apiUrl ?? deps.env.ZOF_API_URL);
    const {request, label} = await buildRequest(o, deps);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 4096) throw usage('The request is over 4 KiB.', 'Shorten --ref or --run-url.');
    const wait = maxWaitMs(o.maxWait);
    const start = deps.now();
    const localDeadline = start + wait;
    say(`Zof gate: ${request.repo} @ ${request.commit_sha.slice(0, 7)} → ${request.environment} (${label})`);

    const headers = {authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': `zof-gate/${deps.version} (${request.pipeline.provider})`};
    const idempotencyKey = `${request.pipeline.provider}:${request.pipeline.run_id}:${request.pipeline.run_attempt}:${request.pipeline.job}:${request.environment}`;
    const expect: Expect = {repo: request.repo, commit_sha: request.commit_sha, environment: request.environment};

    /** One logical call with bounded retries on outages; returns the first non-retryable response. */
    const send = async (method: 'GET' | 'POST', url: string, timeoutMs: number, extra: Record<string, string> = {}, payload?: string): Promise<HttpResponse> => {
      let why = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let delay: number | undefined;
        try {
          const r = await deps.http({method, url, headers: {...headers, ...extra}, ...(payload !== undefined ? {body: payload} : {}), timeoutMs});
          if (r.status !== 408 && r.status !== 429 && r.status < 500) return r;
          why = `HTTP ${r.status}`;
          delay = retryAfterMs(r.headers);
        } catch (error) {
          why = /timeout|abort/i.test(String((error as Error)?.name) + String((error as Error)?.message)) ? 'timed out' : 'network error';
        }
        if (attempt === MAX_ATTEMPTS - 1) break;
        delay ??= Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + deps.random() * 0.5);
        if (deps.now() + delay > localDeadline) break;
        await deps.sleep(delay);
      }
      throw unavailable(`no answer (${why}).`);
    };

    const read = (r: HttpResponse, polling: boolean): GateAnswer => {
      if (r.status >= 200 && r.status < 300) {
        const parsed = parseAnswer(r.text, expect);
        if (!parsed.ok) throw unavailable("an answer this job can't use.");
        return parsed.answer;
      }
      if (r.status < 400) throw unavailable(`an unexpected answer (HTTP ${r.status}).`);
      const code = errorCode(r.text);
      // Agreed with A: a 404 on a gate id this CLI just created is Zof's fault (3); a 404 on the first call stays 2.
      if (polling && r.status === 404) throw unavailable('Zof lost track of this check while waiting, so no answer.', 'not_found');
      // Zof always sends a {code, detail} body; a bare 4xx (other than 401 and 404) came from a proxy or firewall in front of it.
      if (!code && r.status !== 401 && r.status !== 404) throw unavailable(`a proxy or firewall in front of Zof refused the request (HTTP ${r.status}), so no answer.`, `http_${r.status}`);
      const ref = refusal(r.status, code);
      throw new Stop(ref.exit, ref.what, ref.next, ref.code);
    };

    // Server deadline on the local monotonic clock: wait_until - answered_at from the server, anchored at receipt, so runner clock skew can't matter.
    let serverDeadline = Infinity;
    const anchor = (a: GateAnswer): GateAnswer => {
      const remaining = Date.parse(a.wait_until ?? '') - Date.parse(typeof a.answered_at === 'string' ? a.answered_at : '');
      if (Number.isFinite(remaining)) serverDeadline = Math.min(serverDeadline, deps.now() + remaining);
      return a;
    };
    let answer = anchor(read(await send('POST', `${base}/v1/gate/checks`, 30_000, {'content-type': 'application/json', 'idempotency-key': idempotencyKey}, body), false));
    expect.gate_id = answer.gate_id;
    let lastWaiting = '';
    const finish = (exit: ExitCode): ExitCode => { if (json) deps.write('out', redact(JSON.stringify(answer), secrets)); return exit; };

    for (;;) {
      if (answer.state === 'final') {
        if (answer.result === 'pass') {
          say(answer.basis === 'baseline' ? `Passed: this is the approved baseline commit for ${answer.environment}.` : `Passed: Zof allows this deploy to ${answer.environment}.`);
          if (answer.console_url) say(`See ${answer.console_url}`);
          return finish(EXIT.pass);
        }
        say(`Blocked by Zof: ${answer.failure?.message || "Zof didn't allow this deploy."}`);
        for (const reason of answer.reasons.slice(0, 20)) if (reason.message) say(`  - ${reason.message}`);
        if ((answer.reasons_total ?? 0) > answer.reasons.length) say(`  …and ${answer.reasons_total! - answer.reasons.length} more`);
        say(`Next: Fix the reasons, then re-run the job.${answer.console_url ? ` Details: ${answer.console_url}` : ''}`);
        return finish(EXIT.blocked);
      }
      const deadline = Math.min(localDeadline, serverDeadline + SERVER_GRACE_MS);
      const what = answer.waiting_for ?? 'a decision';
      const keys = answer.reasons.map(r => r.requirement_key).filter((k): k is string => typeof k === 'string');
      const summary = `Waiting for ${what}${keys.length ? `: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` and ${keys.length - 3} more` : ''}` : ''}${answer.approve_url ? ` (approve at ${answer.approve_url})` : ''}`;
      if (summary !== lastWaiting) { say(`${summary} · up to ${Math.max(1, Math.ceil((deadline - deps.now()) / 60_000))} min`); lastWaiting = summary; }
      if (o.noWait) {
        say(`Blocked by Zof: still waiting for ${what} (--no-wait asks once).`);
        say('Next: Re-run without --no-wait to wait for it.');
        return finish(EXIT.blocked);
      }
      const now = deps.now();
      if (now >= serverDeadline + SERVER_GRACE_MS) throw unavailable('Zof kept waiting past its own time limit, so no answer.');
      if (now >= localDeadline) {
        say(`Blocked by Zof: still waiting for ${what} after ${Math.round(wait / 60_000)} min.`);
        say(`Next: ${answer.approve_url ? `Approve at ${answer.approve_url}, then re-run` : answer.console_url ? `Check ${answer.console_url}, then re-run` : 'Re-run'} the job, or raise --max-wait.`);
        return finish(EXIT.blocked);
      }
      const poll = Math.min(60, Math.max(1, answer.poll_after_seconds ?? 5)) * 1000 * (0.8 + deps.random() * 0.4);
      await deps.sleep(Math.max(0, Math.min(poll, deadline - deps.now())));
      const waitS = Math.max(0, Math.min(LONG_POLL_SECONDS, Math.floor((localDeadline - deps.now()) / 1000)));
      answer = anchor(read(await send('GET', `${base}/v1/gate/checks/${encodeURIComponent(answer.gate_id)}?wait=${waitS}`, (waitS + 15) * 1000), true));
    }
  } catch (error) {
    if (error instanceof Stop) return stop(error);
    return stop(unavailable('an unexpected error, so no answer.'));
  }
}
