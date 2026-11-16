import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Exit, runGateCli} from '@zof-ai/gate';
import {runGate} from '../dist/gate/index.js';

// Shared-client contract fixtures and synthetic credentials only; every request below uses a fake transport.
const TOKEN = 'zgt_' + 'A'.repeat(43);
const BREAK_GLASS = 'zbg_' + 'B'.repeat(43);
const BASE_ENV = {ZOF_GATE_TOKEN: TOKEN, ZOF_API_URL: 'https://gate.example.test'};
const ARGS = ['--environment', 'prod-eu', '--repo', 'example-org/shop', '--commit', 'a'.repeat(40), '--run-id', '1234567890'];
const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/gate/${name}.json`, import.meta.url), 'utf8'));

function runtime({env = BASE_ENV, body = fixture('pass'), status = 201, throws = false, files = {}} = {}) {
  const stdout = [], stderr = [], sent = [];
  let now = Date.parse('2026-11-13T10:00:00Z');
  const deps = {
    fetch: async (url, init) => {
      sent.push({url, ...init});
      if (throws) throw new Error(`network details ${TOKEN}`);
      return {status, headers: {get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null}, text: async () => JSON.stringify(body)};
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    random: () => 0.5,
  };
  return {env, deps, io: {stdout: s => stdout.push(s), stderr: s => stderr.push(s), readFile: p => files[p]}, stdout, stderr, sent};
}

for (const [label, options, expected] of [
  ['pass', {}, Exit.Pass],
  ['blocked', {body: fixture('fail')}, Exit.Blocked],
  ['configuration', {env: {}}, Exit.Usage],
  ['unavailable', {throws: true}, Exit.Unavailable],
  ['token', {status: 401, body: {code: 'unauthorized', detail: 'invalid token'}}, Exit.Token],
]) {
  test(`shared core and both CLI spellings preserve exit ${expected}: ${label}`, async () => {
    const direct = runtime(options);
    assert.equal(await runGateCli(ARGS, direct.env, direct.io, direct.deps), expected);
    for (const prefix of [[], ['decide']]) {
      const wrapped = runtime(options);
      const args = [...prefix, ...ARGS];
      assert.equal(await runGate(args, wrapped), expected);
      assert.deepEqual(args, [...prefix, ...ARGS], 'the caller owns its argument array');
      assert.deepEqual(wrapped.sent, direct.sent);
      assert.deepEqual(wrapped.stdout, direct.stdout);
      assert.deepEqual(wrapped.stderr, direct.stderr);
      assert.ok(![...wrapped.stdout, ...wrapped.stderr].join('\n').includes(TOKEN));
    }
  });
}

test('JSON is the shared final answer, with no wrapper output on stdout', async () => {
  const r = runtime();
  assert.equal(await runGate([...ARGS, '--json'], r), Exit.Pass);
  assert.equal(r.stdout.length, 1);
  assert.deepEqual(JSON.parse(r.stdout[0]), fixture('pass'));
  assert.ok(r.stderr.length > 0);
});

test('no-wait with a waiting answer never passes', async () => {
  const r = runtime({body: fixture('waiting'), status: 202});
  assert.equal(await runGate([...ARGS, '--no-wait', '--json'], r), Exit.Blocked);
  assert.equal(r.sent.length, 1);
  assert.equal(JSON.parse(r.stdout[0]).state, 'waiting');
});

test('mismatched success and redirect responses remain unavailable', async () => {
  for (const options of [{body: {...fixture('pass'), commit_sha: 'b'.repeat(40)}}, {status: 302, body: {}}]) {
    const r = runtime(options);
    assert.equal(await runGate(ARGS, r), Exit.Unavailable);
    assert.ok(r.sent.every(request => request.redirect === 'error'));
  }
});

test('provider detection and token masking stay in the shared client', async () => {
  for (const [extra, provider] of [
    [{GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'example-org/shop', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '99', GITHUB_JOB: 'deploy'}, 'github_actions'],
    [{GITLAB_CI: 'true', CI_PIPELINE_ID: '99', CI_JOB_NAME: 'deploy', CI_JOB_ID: '7', CI_ENVIRONMENT_NAME: 'prod-eu', CI_COMMIT_SHA: 'a'.repeat(40)}, 'gitlab_ci'],
    [{TF_BUILD: 'True', BUILD_REPOSITORY_PROVIDER: 'GitHub', BUILD_REPOSITORY_NAME: 'example-org/shop', BUILD_SOURCEVERSION: 'a'.repeat(40), BUILD_BUILDID: '99', SYSTEM_JOBDISPLAYNAME: 'deploy'}, 'azure_pipelines'],
  ]) {
    const r = runtime({env: {...BASE_ENV, ...extra}});
    assert.equal(await runGate(ARGS, r), Exit.Pass);
    assert.equal(JSON.parse(r.sent[0].body).pipeline.provider, provider);
    if (provider === 'github_actions') assert.ok(r.stdout.includes(`::add-mask::${TOKEN}`));
  }
});

test('tokens are only environment inputs and redacted even in rejected arguments', async () => {
  const r = runtime({env: {...BASE_ENV, ZOF_BREAK_GLASS_TOKEN: BREAK_GLASS}});
  assert.equal(await runGate([...ARGS, `--token=${TOKEN}`, `--other=${BREAK_GLASS}`], r), Exit.Usage);
  assert.equal(r.sent.length, 0);
  const output = [...r.stdout, ...r.stderr].join('\n');
  assert.ok(!output.includes(TOKEN));
  assert.ok(!output.includes(BREAK_GLASS));
});

test('break-glass requires its token and preserves the shared request', async () => {
  const args = [...ARGS, '--break-glass', 'Outage'];
  const missing = runtime();
  assert.equal(await runGate(args, missing), Exit.Token);
  assert.equal(missing.sent.length, 0);
  const options = {env: {...BASE_ENV, ZOF_BREAK_GLASS_TOKEN: BREAK_GLASS}, body: fixture('break-glass')};
  const direct = runtime(options), wrapped = runtime(options);
  assert.equal(await runGateCli(args, direct.env, direct.io, direct.deps), Exit.Pass);
  assert.equal(await runGate(args, wrapped), Exit.Pass);
  assert.deepEqual(wrapped.sent, direct.sent);
  assert.equal(wrapped.sent[0].headers['X-Zof-Break-Glass'], BREAK_GLASS);
  assert.equal(JSON.parse(wrapped.sent[0].body).break_glass_reason, 'Outage');
  assert.ok(![...wrapped.stdout, ...wrapped.stderr].join('\n').includes(BREAK_GLASS));
});

test('unexpected dependency failures are unavailable, with no exception details', async () => {
  const r = runtime();
  r.deps.now = () => { throw new Error(TOKEN); };
  assert.equal(await runGate(ARGS, r), Exit.Unavailable);
  assert.deepEqual(r.stderr, ['Zof unavailable: the gate client could not finish.']);
});

test('compiled zof dispatches direct gate and legacy decide help without a token', () => {
  for (const args of [['gate', '--help'], ['gate', 'decide', '--help']]) {
    const out = spawnSync(process.execPath, ['dist/cli.js', ...args], {encoding: 'utf8', env: {PATH: process.env.PATH}});
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^Usage: zof gate --environment/);
    assert.match(out.stdout, /--break-glass/);
  }
  const missing = spawnSync(process.execPath, ['dist/cli.js', 'gate', '--environment', 'prod-eu'], {encoding: 'utf8', env: {PATH: process.env.PATH}});
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /ZOF_GATE_TOKEN is not set/);
});
