/**
 * `zof runs create --repo …` (alias `zof run`): plan a manual test run on the console, show it, ask, start exactly what was shown, then follow it
 * (spec 2026-11-21 §2). Ctrl-C stops following and never cancels; `zof runs cancel <id>` cancels.
 */
import {EXIT, type ExitCode} from '../gate/exit.js';
import {Stop, callConsole, clean, finish, printer, refused, usage, type Answer, type RunDeps, type SignIn} from './common.js';

export const RUN_HELP = `zof runs create --repo OWNER/NAME (--pr N | --commit SHA) [--site URL --site-env ENV] [--api URL --api-env ENV]
        --category C [--category C…] [--authorize ORIGIN…] [--yes] [--json]
zof runs cancel mrun_…   (zof run is the same command: zof run --repo …, zof run cancel mrun_…)
Plans the tests, shows each with its gate and the price, asks before starting, then follows the run.
--pr without --commit reads the pull request's head from this checkout's origin. --yes skips the question only when
stdin is not a terminal. Ctrl-C stops following; the run keeps going. Sign in first with zof auth login (or zof login).
Exit 0 all passed, 1 issues found or not all checked, 2 invalid input or refused, 3 Zof unavailable, 4 not signed in.`;

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^mrun_[0-9A-HJKMNP-TV-Z]{26}$/i;
const CATEGORY = /^[a-z][a-z0-9_]{0,31}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,31}$/;
const ORIGIN = /^https?:\/\/[^/\s]+$/;
// Exactly github.com, by its three remote forms: a host or path that only contains github.com is never trusted.
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/i;
const TERMINAL = ['finished', 'cancelled', 'failed', 'timed_out'];
const PLAN_WAIT_MS = 120_000;
const POLL_MS = 2_000;

interface Options {repo?: string; pr?: string; commit?: string; site?: string; siteEnv?: string; api?: string; apiEnv?: string; categories: string[]; authorize: string[]; yes: boolean; json: boolean}
const VALUE: Record<string, keyof Options> = {'--repo': 'repo', '--pr': 'pr', '--commit': 'commit', '--site': 'site', '--site-env': 'siteEnv', '--api': 'api', '--api-env': 'apiEnv'};

function parse(argv: string[]): Options {
  const o: Options = {categories: [], authorize: [], yes: false, json: false};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith('--') && argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    if (flag === '--yes') { o.yes = true; continue; }
    if (flag === '--json') { o.json = true; continue; }
    const value = inline ?? argv[i + 1];
    if (flag === '--category' || flag === '--authorize' || VALUE[flag]) {
      if (inline === undefined) i++;
      if (!value) throw usage(`${flag} needs a value.`);
      if (flag === '--category') o.categories.push(value);
      else if (flag === '--authorize') o.authorize.push(value);
      else (o as unknown as Record<string, string>)[VALUE[flag]] = value;
      continue;
    }
    throw usage(`Unknown option ${clean(flag, 40)}. Run zof runs create --help.`);
  }
  return o;
}

/** The checked inputs, before any network call or keychain read. */
function validate(o: Options) {
  if (!o.repo || !REPO.test(o.repo)) throw usage('Pass --repo owner/name (the GitHub repository).');
  if (!o.pr && !o.commit) throw usage('Pass --pr N or --commit SHA.');
  if (o.pr !== undefined && !/^[1-9][0-9]{0,9}$/.test(o.pr)) throw usage('--pr must be a pull request number.');
  if (o.commit !== undefined && !SHA.test(o.commit.toLowerCase())) throw usage('--commit must be the full 40-character commit SHA.');
  if (!o.site && !o.api) throw usage('Pass --site URL or --api URL: the address the tests run against.');
  for (const [url, flag] of [[o.site, '--site'], [o.api, '--api']] as const) if (url !== undefined && !ORIGIN.test(url)) throw usage(`${flag} must be an origin like https://staging.example.com.`);
  for (const [env, flag] of [[o.siteEnv, '--site-env'], [o.apiEnv, '--api-env']] as const) if (env !== undefined && !ENVIRONMENT.test(env)) throw usage(`${flag} must be an environment name like staging.`);
  if (o.siteEnv && !o.site) throw usage('--site-env needs --site.');
  if (o.apiEnv && !o.api) throw usage('--api-env needs --api.');
  if (!o.categories.length) throw usage('Name at least one --category, for example --category security.');
  if (o.categories.length > 10 || o.categories.some(c => !CATEGORY.test(c)) || new Set(o.categories).size !== o.categories.length) throw usage('--category takes up to 10 different names like security or performance.');
  if (o.authorize.length > 8 || o.authorize.some(a => !ORIGIN.test(a))) throw usage('--authorize takes up to 8 origins like https://staging.example.com.');
}

/** The pull request's head from this checkout's origin, only when origin is the repository named. */
async function prHead(deps: RunDeps, repo: string, pr: string): Promise<string> {
  const fail = usage(`Could not read pull request #${pr}'s head from this checkout. Run inside a clone of ${repo}, or pass --commit with its head SHA.`);
  const remote = await deps.spawn('git', ['remote', 'get-url', 'origin']).catch(() => null);
  const named = remote?.code === 0 ? GITHUB_REMOTE.exec(remote.stdout.replace(/\r?\n$/, ''))?.[1] : undefined;
  if (!named || named.toLowerCase() !== repo.toLowerCase()) throw fail;
  const listed = await deps.spawn('git', ['ls-remote', '--', 'origin', `refs/pull/${pr}/head`]).catch(() => null);
  const sha = listed?.code === 0 ? listed.stdout.trim().split(/\s+/)[0]?.toLowerCase() : undefined;
  if (!sha || !SHA.test(sha)) throw fail;
  return sha;
}

async function signedIn(deps: RunDeps): Promise<SignIn> {
  const signIn = await deps.signIn();
  if (!signIn) throw new Stop(EXIT.token, 'You are not signed in. Run zof auth login.');
  if (signIn.expires_at <= deps.now()) throw new Stop(EXIT.token, 'Your sign-in has expired. Run zof auth login.');
  return signIn;
}

interface Task {task_id: string; category: string; title: string; ticked: boolean; gate: string; state: string; outcome: string}

function tasksOf(body: Record<string, unknown>): Task[] {
  const raw = Array.isArray(body.tasks) ? body.tasks : [];
  return raw.flatMap(t => {
    if (typeof t !== 'object' || t === null) return [];
    const r = t as Record<string, unknown>;
    if (typeof r.task_id !== 'string' || !/^mtsk_[0-9A-HJKMNP-TV-Z]{26}$/i.test(r.task_id)) return [];
    const gate = typeof r.gate === 'object' && r.gate !== null ? (r.gate as Record<string, unknown>) : {};
    const ok = gate.ok === true;
    return [{
      task_id: r.task_id, category: clean(r.category, 40) || 'other', title: clean(r.title, 200) || r.task_id,
      // Only a task the console ticks and whose gate passed is ever started from here.
      ticked: r.default_ticked === true && ok,
      gate: ok ? '' : `${clean(gate.message, 300) || 'Start it in Zof.'}${typeof gate.code === 'string' ? ` (${clean(gate.code, 40)})` : ''}`,
      state: clean(r.state, 30), outcome: clean(r.outcome, 30),
    }];
  });
}

function price(body: Record<string, unknown>): string {
  const billing = typeof body.billing === 'object' && body.billing !== null ? (body.billing as Record<string, unknown>) : {};
  if (billing.mode === 'free_for_now') return 'free for now';
  const credits = billing.estimate_credits;
  if (billing.mode === 'credits' && typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) return `${credits} ${credits === 1 ? 'credit' : 'credits'}`;
  // An unreadable price is never shown as free.
  return 'a price Zof will show you';
}

export async function runCommand(argv: string[], deps: RunDeps): Promise<ExitCode> {
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) { deps.write('out', RUN_HELP); return EXIT.pass; }
  let say = printer(deps, [], false);
  try {
    if (argv[0] === 'cancel') return await cancel(argv.slice(1), deps);
    const o = parse(argv);
    validate(o);
    const signIn = await signedIn(deps);
    say = printer(deps, [signIn.token], o.json);
    const repo = o.repo as string;
    const sha = o.commit ? o.commit.toLowerCase() : await prHead(deps, repo, o.pr as string);
    const call = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string, timeoutMs?: number) =>
      callConsole(deps, signIn.console, {method, path, token: signIn.token, ...(body !== undefined ? {body} : {}), ...(key ? {idempotencyKey: key} : {}), ...(timeoutMs ? {timeoutMs} : {})});
    const environment = {...(o.siteEnv ? {site: o.siteEnv} : {}), ...(o.apiEnv ? {api: o.apiEnv} : {})};
    const planBody = {
      repo, sha, ref: o.pr ? {kind: 'pr', label: `#${o.pr}`} : {kind: 'commit', label: sha},
      ...(o.site ? {site_url: o.site} : {}), ...(o.api ? {api_url: o.api} : {}),
      ...(Object.keys(environment).length ? {environment} : {}), categories: o.categories,
    };
    const planned = await call('POST', '/api/runs/plan', planBody, deps.uuid(), 65_000);
    if (planned.status !== 201 && planned.status !== 202) throw refused(planned, 'the plan');
    const runId = typeof planned.body.run_id === 'string' && RUN_ID.test(planned.body.run_id) ? planned.body.run_id : '';
    if (!runId) throw new Stop(EXIT.unavailable, "Zof's plan answer could not be used.");
    const link = `${signIn.console}/runs/${runId}`;
    // The read shows the live gates and the price; a plan still being made is read again for up to 2 minutes.
    let view = await readRun(call, runId);
    const until = deps.now() + PLAN_WAIT_MS;
    while (view.body.state === 'planning') {
      if (deps.now() >= until) throw new Stop(EXIT.unavailable, `Zof is still planning this run. See it at ${link}.`);
      await deps.sleep(POLL_MS);
      view = await readRun(call, runId);
    }
    if (view.body.state !== 'planned') throw new Stop(EXIT.config, `The run is ${clean(view.body.state, 30)}, not waiting to start. See ${link}.`, 'not_planned');
    const planSha = typeof view.body.plan_sha256 === 'string' && /^[0-9a-f]{64}$/.test(view.body.plan_sha256) ? view.body.plan_sha256 : '';
    if (!planSha) throw new Stop(EXIT.unavailable, "Zof's plan has no fingerprint, so nothing was started.");
    const tasks = tasksOf(view.body);
    const ticked = tasks.filter(t => t.ticked);
    const cost = price(view.body);
    say(`Plan ${runId} for ${repo} @ ${sha.slice(0, 7)}${o.pr ? ` (pull request #${o.pr})` : ''}`);
    for (const category of [...new Set(tasks.map(t => t.category))]) {
      say(`${category[0].toUpperCase()}${category.slice(1)}`);
      for (const t of tasks.filter(x => x.category === category)) say(t.ticked ? `  [x] ${t.title}` : `  [ ] ${t.title}: ${t.gate || 'Not started from here; start it in Zof.'}`);
    }
    const expires = typeof view.body.plan_expires_at === 'string' ? ` · expires ${clean(view.body.plan_expires_at, 40)}` : '';
    say(`Price: ${cost} · plan ${planSha.slice(0, 12)}${expires}`);
    if (!ticked.length) throw new Stop(EXIT.config, `None of these tests can start from here. Open ${link} to start them.`, 'nothing_to_start');
    const question = `Run ${ticked.length} ${ticked.length === 1 ? 'test' : 'tests'} for ${cost}? [y/N] `;
    // --yes answers only when no person can: with a terminal the question is still asked.
    if (deps.interactive) {
      const reply = (await deps.ask(question))?.trim().toLowerCase();
      if (reply !== 'y' && reply !== 'yes') { say(`Not started. The plan stays in Zof until it expires: ${link}`); return EXIT.pass; }
    } else if (!o.yes) {
      throw usage('stdin is not a terminal, so zof runs create cannot ask before starting. Pass --yes to start the ticked tests.');
    }
    const started = await call('POST', `/api/runs/${runId}/start`, {plan_sha256: planSha, approved_task_ids: ticked.map(t => t.task_id), authorized_origins: o.authorize}, deps.uuid(), 65_000);
    if (started.status !== 202) throw refused(started, 'the start');
    say(`Started ${ticked.length} ${ticked.length === 1 ? 'test' : 'tests'}. Follow it in Zof: ${link}`);
    return await follow(deps, call, runId, link, ticked, say, o.json);
  } catch (error) {
    return finish(say, error);
  }
}

type Caller = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string, timeoutMs?: number) => Promise<Answer>;

async function readRun(call: Caller, runId: string): Promise<Answer> {
  const r = await call('GET', `/api/runs/${runId}`);
  if (r.status !== 200) throw refused(r, 'reading the run');
  return r;
}

/** Task states and confirmed findings until the run ends; Ctrl-C stops following and never cancels. */
async function follow(deps: RunDeps, call: Caller, runId: string, link: string, started: Task[], say: (line: string) => void, json: boolean): Promise<ExitCode> {
  const titles = new Map(started.map(t => [t.task_id, t.title]));
  let stopped = false;
  const release = deps.onInterrupt(() => { stopped = true; });
  try {
    let after: number | null = null;
    for (;;) {
      if (stopped) {
        say(`Stopped following. The run keeps going: ${link}. To stop it: zof runs cancel ${runId}`);
        return EXIT.blocked;
      }
      const r = await call('GET', `/api/runs/${runId}/events${after === null ? '' : `?after=${after}`}`);
      if (r.status !== 200) throw refused(r, 'reading the run events');
      const events = Array.isArray(r.body.events) ? r.body.events : [];
      for (const e of events) {
        if (typeof e !== 'object' || e === null) continue;
        const ev = e as Record<string, unknown>;
        if (typeof ev.seq === 'number' && Number.isSafeInteger(ev.seq)) after = Math.max(after ?? 0, ev.seq);
        const line = eventLine(ev, titles);
        if (line) say(line);
      }
      if (typeof r.body.next_after === 'number' && Number.isSafeInteger(r.body.next_after)) after = r.body.next_after;
      if (TERMINAL.includes(String(r.body.state))) break;
      await deps.sleep(POLL_MS);
    }
    const end = await readRun(call, runId);
    const tasks = tasksOf(end.body).filter(t => titles.has(t.task_id));
    const passed = tasks.filter(t => t.outcome === 'passed').length;
    const issues = tasks.filter(t => t.outcome === 'found_issues').length;
    const unchecked = tasks.length - passed - issues;
    const state = clean(end.body.state, 30);
    say(`Run ${state}: ${passed} passed, ${issues} found issues, ${unchecked} couldn't be checked. ${link}`);
    if (json) deps.write('out', JSON.stringify({run_id: runId, state, passed, found_issues: issues, couldnt_check: unchecked, url: link}));
    return state === 'finished' && tasks.length > 0 && passed === tasks.length ? EXIT.pass : EXIT.blocked;
  } finally {
    release();
  }
}

function eventLine(e: Record<string, unknown>, titles: Map<string, string>): string | null {
  const d = typeof e.detail === 'object' && e.detail !== null ? (e.detail as Record<string, unknown>) : {};
  const title = typeof e.task_id === 'string' ? (titles.get(e.task_id) ?? clean(e.task_id, 40)) : 'Run';
  switch (e.type) {
    case 'manual_run.task.state': return `${title}: ${clean(d.to, 30)}`;
    case 'manual_run.task.outcome': return `${title}: ${clean(d.outcome, 30).replace('_', ' ')}`;
    // Only confirmed findings are printed; anything else stays on the run page.
    case 'manual_run.task.finding': return d.confirmed === true ? `${title}: finding (${clean(d.severity, 20) || 'unrated'}) ${clean(d.title, 200)}` : null;
    default: return null;
  }
}

async function cancel(argv: string[], deps: RunDeps): Promise<ExitCode> {
  const runId = argv[0] ?? '';
  if (argv.length !== 1 || !RUN_ID.test(runId)) throw usage('Use: zof runs cancel mrun_… (the run id zof runs create printed).');
  const signIn = await signedIn(deps);
  const say = printer(deps, [signIn.token], false);
  const r = await callConsole(deps, signIn.console, {method: 'POST', path: `/api/runs/${runId}/cancel`, body: {}, token: signIn.token});
  if (r.status !== 202) throw refused(r, 'the cancel');
  say(`Cancelling ${runId}. ${signIn.console}/runs/${runId}`);
  return EXIT.pass;
}

