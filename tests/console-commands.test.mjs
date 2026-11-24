import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {consoleCommand, DEVICE_CLIENT_ID, authorizeBody, tokenBody, DEFAULT_CONSOLE_URL, loadConfig, consoleToken} from '../dist/console/index.js';

// Synthetic values only: a throwaway home, a scripted console, no network.
const TOKEN = 'zofcli_' + 'T'.repeat(24);
const REV = 'rev_' + '0'.repeat(25) + '1';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});

async function run(topic, argv, {env = {ZOF_TOKEN: TOKEN, ZOF_CONSOLE_URL: 'http://localhost:3000'}, routes = {}, input = '', files = {}} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'zof-console-home-'));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(home, '.zof'), {recursive: true}); writeFileSync(join(home, '.zof', p), c); }
  const requests = [];
  const lines = [];
  const opened = [];
  const written = {};
  let t = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({method: init.method ?? 'GET', path: u.pathname + u.search, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined});
    const key = `${init.method ?? 'GET'} ${u.pathname}`;
    const r = routes[key];
    if (!r) throw new TypeError('fetch failed');
    const next = Array.isArray(r) ? (r.length > 1 ? r.shift() : r[0]) : r;
    return typeof next === 'function' ? next(init) : next.clone();
  };
  const deps = {
    version: '9.9.9-test', env, home, fetch,
    write: (stream, line) => lines.push({stream, line}),
    sleep: async ms => { t += ms; }, now: () => t, uuid: () => 'uuid-1', hostname: () => 'host-1', platform: 'linux', isTty: false,
    openUrl: async url => { opened.push(url); return true; },
    writeFile: (p, c) => { written[p] = c; },
    input: Readable.from([input]), onInterrupt: () => () => {},
  };
  try {
    const code = await consoleCommand(topic, argv, deps);
    const read = name => (existsSync(join(home, '.zof', name)) ? readFileSync(join(home, '.zof', name), 'utf8') : null);
    return {code, requests, opened, written, out: lines.filter(l => l.stream === 'out').map(l => l.line).join('\n'), err: lines.filter(l => l.stream === 'err').map(l => l.line).join('\n'), config: read('config.json'), credentials: read('credentials.json'), credMode: existsSync(join(home, '.zof', 'credentials.json')) ? statSync(join(home, '.zof', 'credentials.json')).mode & 0o777 : null};
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}

describe('device flow client id', () => {
  test('is zof-cli-app, the id in the console device-flow allow-list, on authorize and on every poll', async () => {
    assert.equal(DEVICE_CLIENT_ID, 'zof-cli-app');
    assert.equal(authorizeBody('1', 'h', 'linux').client_id, 'zof-cli-app');
    assert.equal(tokenBody('dc').client_id, 'zof-cli-app');
    assert.equal(tokenBody('dc').grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  });
});

describe('zof auth', () => {
  const device = {device_code: 'dc_1', user_code: 'ABCD-EFGH', verification_uri: 'http://localhost:3000/device', verification_uri_complete: 'http://localhost:3000/device?code=ABCD-EFGH', expires_in: 600, interval: 1};
  const session = {user: {id: 'u1', email: 'dev@example.test', name: 'Dev'}, tenant: {id: 'org_1', name: 'Example', slug: 'example'}, scopes: ['cli']};

  test('login polls through pending and slow_down, then stores the token 0600 bound to its console', async () => {
    const r = await run('auth', ['login'], {
      env: {ZOF_CONSOLE_URL: 'http://localhost:3000'},
      routes: {
        'POST /api/auth/device/authorize': json(200, device),
        'POST /api/auth/device/token': [json(400, {error: 'authorization_pending'}), json(400, {error: 'slow_down'}), json(200, {access_token: TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'cli'})],
        'GET /api/cli/session': json(200, session),
      },
    });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.requests[0].body, {client_id: 'zof-cli-app', scope: 'cli', cli_metadata: {hostname: 'host-1', machine_label: 'host-1-cli', platform: 'linux', cli_version: '9.9.9-test'}});
    assert.equal(r.requests.filter(q => q.path === '/api/auth/device/token').length, 3);
    assert.equal(r.requests.at(-1).headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(r.opened, [device.verification_uri_complete]);
    const creds = JSON.parse(r.credentials);
    assert.deepEqual([creds.access_token, creds.org_id, creds.console_url], [TOKEN, 'org_1', 'http://localhost:3000']);
    assert.equal(r.credMode, 0o600);
    assert.equal(JSON.parse(r.config).org_id, 'org_1');
    assert.match(r.out, /Authenticated as dev@example\.test/);
    assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN), 'the token is never printed');
  });

  test('login stops on access_denied and never opens a page on another host', async () => {
    const r = await run('auth', ['login'], {
      env: {ZOF_CONSOLE_URL: 'http://localhost:3000'},
      routes: {'POST /api/auth/device/authorize': json(200, {...device, verification_uri_complete: 'https://evil.example.test/x'}), 'POST /api/auth/device/token': json(400, {error: 'access_denied'})},
    });
    assert.equal(r.code, 1);
    assert.deepEqual(r.opened, []);
    assert.match(r.err, /denied/);
    assert.equal(r.credentials, null);
  });

  test('an unknown client id is shown from the server, not as an expired session', async () => {
    const r = await run('auth', ['login'], {routes: {'POST /api/auth/device/authorize': json(401, {error: 'invalid_client', error_description: 'Unknown client_id'})}});
    assert.equal(r.code, 1);
    assert.match(r.err, /Unknown client_id/);
  });

  test('whoami without any sign-in exits 1 with the login hint and sends nothing', async () => {
    const r = await run('auth', ['whoami'], {env: {}});
    assert.equal(r.code, 1);
    assert.match(r.err, /zof auth login/);
    assert.equal(r.requests.length, 0);
  });

  test('whoami --json prints the session; logout removes the stored sign-in', async () => {
    const r = await run('auth', ['whoami', '--json'], {routes: {'GET /api/cli/session': json(200, session)}});
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).tenant.slug, 'example');
    const out = await run('auth', ['logout'], {files: {'credentials.json': JSON.stringify({access_token: TOKEN})}});
    assert.equal(out.code, 0);
    assert.equal(out.credentials, null);
  });
});

describe('console URL and token (production default, token bound to its console)', () => {
  test('defaults to the production console; ZOF_CONSOLE_URL, then console_url (or the older api_url) override it', () => {
    const home = mkdtempSync(join(tmpdir(), 'zof-cfg-'));
    try {
      assert.equal(DEFAULT_CONSOLE_URL, 'https://console.zof.ai');
      assert.equal(loadConfig({}, home).console_url, 'https://console.zof.ai');
      mkdirSync(join(home, '.zof'));
      writeFileSync(join(home, '.zof', 'config.json'), JSON.stringify({api_url: 'https://staging.example.test'}));
      assert.equal(loadConfig({}, home).console_url, 'https://staging.example.test');
      assert.equal(loadConfig({ZOF_CONSOLE_URL: 'http://localhost:3000'}, home).console_url, 'http://localhost:3000');
    } finally { rmSync(home, {recursive: true, force: true}); }
  });

  test('ZOF_API_URL (the gate Control Plane URL) is never used as the console', () => {
    const home = mkdtempSync(join(tmpdir(), 'zof-cfg-'));
    try { assert.equal(loadConfig({ZOF_API_URL: 'https://cp.example.test'}, home).console_url, 'https://console.zof.ai'); } finally { rmSync(home, {recursive: true, force: true}); }
  });

  test('a saved token goes only to the console that issued it; ZOF_TOKEN is used as given', () => {
    const home = mkdtempSync(join(tmpdir(), 'zof-cfg-'));
    try {
      mkdirSync(join(home, '.zof'));
      writeFileSync(join(home, '.zof', 'credentials.json'), JSON.stringify({access_token: 'zofcli_local', api_url: 'http://localhost:3000/'}));
      assert.equal(consoleToken({ZOF_CONSOLE_URL: 'http://localhost:3000'}, home), 'zofcli_local');
      assert.equal(consoleToken({ZOF_CONSOLE_URL: 'https://console.zof.ai'}, home), null);
      assert.equal(consoleToken({ZOF_CONSOLE_URL: 'https://console.zof.ai', ZOF_TOKEN: 'zofcli_ci'}, home), 'zofcli_ci');
      writeFileSync(join(home, '.zof', 'credentials.json'), JSON.stringify({access_token: 'zofcli_old'}));
      assert.equal(consoleToken({}, home), 'zofcli_old');
    } finally { rmSync(home, {recursive: true, force: true}); }
  });
});

describe('zof config', () => {
  test('set validates the console URL and writes only the stored file, never environment overrides', async () => {
    const bad = await run('config', ['set', 'console_url', 'http://console.example.test'], {env: {}});
    assert.equal(bad.code, 2);
    const ok = await run('config', ['set', 'console_url', 'https://console.example.test/'], {env: {ZOF_ORG_ID: 'org_env'}});
    assert.equal(ok.code, 0);
    assert.deepEqual(JSON.parse(ok.config), {console_url: 'https://console.example.test'});
    assert.equal((await run('config', ['set', 'password', 'x'], {env: {}})).code, 2);
  });

  test('get prints one value, and list --json shows the effective configuration', async () => {
    const r = await run('config', ['get', 'console_url'], {env: {}});
    assert.equal(r.out, 'https://console.zof.ai');
    const list = await run('config', ['list', '--json'], {env: {ZOF_ENV_ID: 'staging'}});
    assert.equal(JSON.parse(list.out).env_id, 'staging');
  });
});

describe('zof review', () => {
  const ref = json(200, {ref: {kind: 'pr', pr: 42, change_id: 'chg_1'}});
  const started = json(202, {review_id: REV, run_id: 'rrn_1'});
  const detail = (status, complete) => json(200, {review: {review_id: REV, status, complete, counts_by_severity: {high: 1}}, findings: [{severity: 'high', title: 'SQL injection', source_location: {path: 'src/db.ts', line: 9}}]});

  test('usage errors exit 2 and send nothing: bad URL, --timeout over 3600, --timeout without --wait, bad review id', async () => {
    for (const argv of [['https://gitlab.com/a/b/pull/1'], ['https://github.com/acme/web/pull/42', '--wait', '--timeout', '3601'], ['https://github.com/acme/web/pull/42', '--timeout', '30'], ['show', 'rev_x'], []]) {
      const r = await run('review', argv);
      assert.equal(r.code, argv.length ? 2 : 0, argv.join(' '));
      assert.equal(r.requests.length, 0);
    }
  });

  test('without --wait it starts the review and prints where to see it', async () => {
    const r = await run('review', ['https://github.com/acme/web/pull/42', '--json'], {routes: {'GET /api/run/refs': ref, 'POST /api/reviews': started}});
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), {review_id: REV, run_id: 'rrn_1', url: `http://localhost:3000/code-review/${REV}`});
    assert.equal(r.requests[1].headers['Idempotency-Key'], 'uuid-1');
  });

  test('--wait polls to done and exits 0 only for a complete review', async () => {
    const r = await run('review', ['https://github.com/acme/web/pull/42', '--wait'], {routes: {'GET /api/run/refs': ref, 'POST /api/reviews': started, [`GET /api/reviews/${REV}`]: [detail('reviewing', null), detail('done', true)]}});
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\[high\] SQL injection — src\/db\.ts:9/);
    const incomplete = await run('review', ['https://github.com/acme/web/pull/42', '--wait', '--json'], {routes: {'GET /api/run/refs': ref, 'POST /api/reviews': started, [`GET /api/reviews/${REV}`]: detail('done', false)}});
    assert.equal(incomplete.code, 1);
    assert.equal(JSON.parse(incomplete.out).timed_out, false);
  });

  test('--wait --timeout reports the timeout and exits 1', async () => {
    const r = await run('review', ['https://github.com/acme/web/pull/42', '--wait', '--timeout', '12', '--json'], {routes: {'GET /api/run/refs': ref, 'POST /api/reviews': started, [`GET /api/reviews/${REV}`]: detail('reviewing', null)}});
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).timed_out, true);
  });

  test('a refs pr_not_found explains which PRs can be reviewed', async () => {
    const r = await run('review', ['https://github.com/acme/web/pull/42'], {routes: {'GET /api/run/refs': json(404, {code: 'pr_not_found'})}});
    assert.equal(r.code, 1);
    assert.match(r.err, /only open pull requests in a repository connected to your org/);
  });

  test('review show --json prints the review and exits 1 while it is still running', async () => {
    const done = await run('review', ['show', REV, '--json'], {routes: {[`GET /api/reviews/${REV}`]: detail('done', true)}});
    assert.equal(done.code, 0);
    assert.equal(JSON.parse(done.out).review.review_id, REV);
    const running = await run('review', ['show', REV], {routes: {[`GET /api/reviews/${REV}`]: detail('reviewing', null)}});
    assert.equal(running.code, 1);
  });
});

describe('zof copilot', () => {
  const stream = events => () => new Response(events.map((e, i) => `id: ${i}\ndata: ${JSON.stringify({v: 1, seq: i, ...e})}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
  const answer = stream([{type: 'tool', name: 'runs_list', status: 'done', label: 'Looked up runs'}, {type: 'token', text: 'secret', kind: 'thinking'}, {type: 'final', text: 'Two runs failed.', citations: [], sources: [], status: 'complete'}, {type: 'done', reason: 'complete'}]);

  test('ask prints tool lines and the answer, exit 0', async () => {
    const r = await run('copilot', ['ask', 'Why did runs fail?'], {routes: {'POST /api/copilot/conversations': json(200, {id: 'c1'}), 'POST /api/copilot/chat': answer}});
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /· Looked up runs/);
    assert.match(r.out, /Two runs failed\./);
    assert.ok(!r.out.includes('secret'));
    assert.deepEqual(r.requests[1].body, {conversationId: 'c1', message: 'Why did runs fail?', stream: true});
  });

  test('ask --json carries no tokens; a blank question is a usage error (exit 2)', async () => {
    const r = await run('copilot', ['ask', 'q', '--json'], {routes: {'POST /api/copilot/conversations': json(200, {id: 'c1'}), 'POST /api/copilot/chat': answer}});
    assert.deepEqual(JSON.parse(r.out).events.map(e => e.type), ['tool', 'final', 'done']);
    const blank = await run('copilot', ['ask', '   ']);
    assert.equal(blank.code, 2);
    assert.equal(blank.requests.length, 0);
  });

  test('the cost guard 503 says Copilot is unavailable with its Retry-After, exit 1', async () => {
    const r = await run('copilot', ['ask', 'q'], {routes: {'POST /api/copilot/conversations': json(503, {error: 'This is temporarily unavailable. Try again shortly.', code: 'unavailable'}, {'retry-after': '60'})}});
    assert.equal(r.code, 1);
    assert.match(r.err, /Copilot is temporarily unavailable\. Retry after 60s\./);
  });

  test('chat answers each line in one conversation and ends at exit', async () => {
    const r = await run('copilot', ['chat'], {input: 'first\nsecond\nexit\n', routes: {'POST /api/copilot/conversations': json(200, {id: 'c1'}), 'POST /api/copilot/chat': answer}});
    assert.equal(r.code, 0, r.err);
    assert.equal(r.requests.filter(q => q.path === '/api/copilot/conversations').length, 1);
    assert.equal(r.requests.filter(q => q.path === '/api/copilot/chat').length, 2);
  });
});

describe('other console commands', () => {
  test('runs list, runs create and runs cancel call the console routes', async () => {
    const list = await run('runs', ['list', '--status', 'running', '--json'], {routes: {'GET /api/runs': json(200, {data: {runs: [{id: 'run_1', title: 'Nightly', status: 'running'}], total: 1}})}});
    assert.equal(list.code, 0);
    assert.equal(list.requests[0].path, '/api/runs?status=running&limit=25&page=1');
    const created = await run('runs', ['create', '--name', 'Nightly', '--trigger', 'ci'], {routes: {'POST /api/runs': json(201, {data: {id: 'run_2', title: 'Nightly', status: 'queued'}})}});
    assert.equal(created.code, 0);
    assert.deepEqual(created.requests[0].body, {title: 'Nightly', trigger: 'ci'});
    const cancelled = await run('runs', ['cancel', 'run/../x'], {routes: {'PUT /api/runs/run%2F..%2Fx': json(200, {ok: true})}});
    assert.equal(cancelled.code, 0, cancelled.err);
    assert.deepEqual(cancelled.requests[0].body, {status: 'cancelled'});
    assert.equal((await run('runs', ['create'])).code, 2);
  });

  test('agents, approvals and artifacts', async () => {
    const agents = await run('agents', ['list', '--category', 'security'], {routes: {'GET /api/ai-agents': json(200, {data: [{key: 'vuln_scan', name: 'Vuln scan', agent_class: 'testing', category_key: 'security'}]})}});
    assert.equal(agents.code, 0);
    assert.match(agents.out, /vuln_scan/);
    assert.equal((await run('agents', ['run', 'x', '--config', 'not json'])).code, 2);
    const approve = await run('approvals', ['approve', 'plan_1', '--reason', 'ok'], {routes: {'POST /api/remediation/plans/plan_1/approve': json(200, {ok: true})}});
    assert.deepEqual(approve.requests[0].body, {reason: 'ok', source: 'cli'});
    const dl = await run('artifacts', ['download', 'a1', '--run-id', 'er_1', '-o', 'out.json'], {routes: {'GET /api/engine-runs/er_1/artifacts': json(200, {data: [{id: 'a1', name: 'report'}]})}});
    assert.equal(dl.code, 0);
    assert.deepEqual(JSON.parse(dl.written['out.json']), {id: 'a1', name: 'report'});
    assert.equal((await run('artifacts', ['list'])).code, 2);
  });

  test('a 402 explains credits, exit 1; services ping fails 1 when the console is unreachable', async () => {
    const r = await run('runs', ['list'], {routes: {'GET /api/runs': json(402, {})}});
    assert.equal(r.code, 1);
    assert.match(r.err, /Credits exceeded/);
    assert.equal((await run('services', ['ping', '--json'], {env: {ZOF_CONSOLE_URL: 'http://localhost:3000'}})).code, 1);
    const ok = await run('services', ['status', '--json'], {env: {}, routes: {'GET /api/health': json(200, {status: 'healthy'})}});
    assert.equal(ok.code, 0);
  });

  test('events stream prints events until the stream ends (exit 1: it was not stopped by the user)', async () => {
    const sse = () => new Response('id: 1\ndata: {"type":"run.started","entityId":"run_1","createdAt":"2030-01-01T00:00:00Z"}\n\n', {headers: {'content-type': 'text/event-stream'}});
    const r = await run('events', ['stream', '--json', '--topics', 'runs'], {routes: {'GET /api/events/stream': sse}});
    assert.equal(r.requests[0].path, '/api/events/stream?topics=runs');
    assert.equal(JSON.parse(r.out).type, 'run.started');
    assert.equal(r.code, 1);
  });
});

describe('the zof binary', () => {
  const cli = resolve('dist/cli.js');
  const call = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', timeout: 10000, env: {PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'zof-bin-')), ...env}});

  test('help lists the local tools, gate and the console topics', () => {
    const r = call(['help']);
    assert.equal(r.status, 0);
    for (const word of ['verify', 'gate decide', 'auth', 'review', 'copilot', 'ZOF_CONSOLE_URL']) assert.ok(r.stdout.includes(word), word);
  });

  test('console commands dispatch with their exit codes; gate decide still reads only its own env', () => {
    assert.equal(call(['review', 'not-a-url']).status, 2);
    assert.equal(call(['auth', 'whoami']).status, 1);
    assert.equal(call(['copilot', '--help']).status, 0);
    // A console token does not satisfy the gate: it still asks for ZOF_GATE_TOKEN (exit 2, configuration).
    const gate = call(['gate', 'decide', '--environment', 'production'], {ZOF_TOKEN: TOKEN, ZOF_CONSOLE_URL: 'http://localhost:3000'});
    assert.equal(gate.status, 2);
    assert.match(gate.stdout + gate.stderr, /ZOF_GATE_TOKEN/);
  });
});
