import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiClient, ApiError, stripControl, consoleOrigin, parseArgs, UsageError,
  cleanText, eventLine, jsonEvents, readEvents, turnOutcome, askTurn, conversationTitle, errorHint, startConversation,
  renderReview, renderNoAnswer, reviewJson, startReview, reviewUrl, parsePrUrl, PR_URL_HELP, waitForReview, reviewExitCode,
  buildRunCreateBody, RUN_CREATE_TRIGGERS, readSse, formatJson, formatDuration,
  utf8Locale, glyphs, wrap, fit, elapsed, spinner,
} from '../dist/console/index.js';

// Synthetic values only; no real network, tokens or customers.
const respond = (status, body, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
function client(answer, over = {}) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({url, init}); return typeof answer === 'function' ? answer(url, init) : answer.clone(); };
  return {calls, api: new ApiClient({baseUrl: 'http://localhost:3000', token: 'zofcli_test_token', orgId: null, version: '0.0.0-test', fetch, ...over})};
}
const caught = p => p.then(() => assert.fail('expected a rejection'), e => e);

describe('ApiError and stripControl', () => {
  test('carries status, code, message and request id', () => {
    const err = new ApiError(401, 'UNAUTHENTICATED', 'Session expired', 'req_123');
    assert.deepEqual([err.statusCode, err.errorCode, err.message, err.requestId, err.name], [401, 'UNAUTHENTICATED', 'Session expired', 'req_123', 'ApiError']);
    assert.ok(err instanceof Error);
    assert.equal(new ApiError(404, 'NOT_FOUND', 'x').requestId, undefined);
  });

  test('stripControl drops ANSI, OSC and control characters', () => {
    assert.equal(stripControl('bad\u001b[31m red\u001b[0m\u0007\r\nline'), 'bad red line');
    assert.equal(stripControl('\u001b]0;pwn\u0007Unknown client_id'), 'Unknown client_id');
  });
});

describe('ApiClient error mapping', () => {
  test('names the server code in a 403 message only; errorCode stays FORBIDDEN', async () => {
    const err = await caught(client(respond(403, {code: 'cross_site'})).api.post('/api/reviews', {}));
    assert.equal(err.errorCode, 'FORBIDDEN');
    assert.equal(err.message, 'Permission denied (cross_site). Check your role and org access.');
    const plain = await caught(client(respond(403, {})).api.post('/x', {}));
    assert.equal(plain.message, 'Permission denied. Check your role and org access.');
  });

  test('carries Retry-After seconds, and ignores a date', async () => {
    const err = await caught(client(respond(429, {code: 'rate_limited'}, {'retry-after': '12'})).api.post('/x', {}));
    assert.deepEqual([err.statusCode, err.retryAfterS], [429, 12]);
    const dated = await caught(client(respond(503, {code: 'unavailable'}, {'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT'})).api.post('/x', {}));
    assert.equal(dated.retryAfterS, undefined);
  });

  test('shows a bare code instead of the HTTP status', async () => {
    const err = await caught(client(respond(409, {code: 'idempotency_conflict'})).api.post('/api/reviews', {}));
    assert.deepEqual([err.statusCode, err.message], [409, 'idempotency_conflict']);
  });

  test('sends a given Idempotency-Key with the bearer, no Origin or Cookie, and never follows a redirect', async () => {
    const {api, calls} = client(respond(202, {review_id: 'rev_1', run_id: 'rrn_1'}));
    await api.post('/api/reviews', {change_id: 'c'}, {headers: {'Idempotency-Key': 'k-1'}});
    const {headers, redirect} = calls[0].init;
    assert.equal(headers['Idempotency-Key'], 'k-1');
    assert.equal(headers.Authorization, 'Bearer zofcli_test_token');
    assert.equal(headers['x-zof-cli-version'], '0.0.0-test');
    assert.equal(redirect, 'manual');
    const names = Object.keys(headers).map(h => h.toLowerCase());
    assert.ok(!names.includes('origin') && !names.includes('cookie'));
  });

  test('a device-flow 401 shows the server error_description; elsewhere it says Session expired', async () => {
    const device = await caught(client(respond(401, {error: 'invalid_client', error_description: '\u001b]0;pwn\u0007Unknown client_id'})).api.post('/api/auth/device/authorize', {}, {requireAuth: false}));
    assert.equal(device.message, 'Unknown client_id');
    const other = await caught(client(respond(401, {error: 'nope'})).api.post('/api/reviews', {}));
    assert.match(other.message, /Session expired/);
  });

  test('a generic error message is cleaned of control characters', async () => {
    const err = await caught(client(respond(500, {message: 'bad\u001b[31m red\u001b[0m\u0007\r\nline'})).api.post('/x', {}));
    assert.equal(err.message, 'bad red line');
  });

  test('without a token it refuses before sending anything', async () => {
    const {api, calls} = client(respond(200, {}), {token: null});
    const err = await caught(api.get('/api/runs'));
    assert.equal(err.statusCode, 401);
    assert.equal(calls.length, 0);
  });

  test('refuses a non-https console (but allows localhost) and a URL with a path or credentials', async () => {
    assert.equal(consoleOrigin('https://console.example.test/'), 'https://console.example.test');
    assert.equal(consoleOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    for (const bad of ['http://console.example.test', 'https://u:p@console.example.test', 'https://console.example.test/x', 'https://console.example.test/?a=1', 'nope']) {
      assert.throws(() => consoleOrigin(bad), ApiError, bad);
    }

    const {api, calls} = client(respond(200, {}), {baseUrl: 'http://console.example.test'});
    await caught(api.get('/api/runs'));
    assert.equal(calls.length, 0);
  });

  test('a network failure names ZOF_CONSOLE_URL; an abort is a timeout', async () => {
    const net = await caught(client(() => { throw new TypeError('fetch failed'); }).api.get('/x'));
    assert.equal(net.errorCode, 'NETWORK_ERROR');
    assert.match(net.message, /ZOF_CONSOLE_URL/);
    const slow = await caught(client((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))))).api.get('/x', {timeout: 5}));
    assert.equal(slow.statusCode, 408);
  });

  test('postStream returns the ok response unread, asking for a stream', async () => {
    const {api, calls} = client(() => new Response('data: {}\n\n', {status: 200, headers: {'content-type': 'text/event-stream'}}));
    const res = await api.postStream('/api/copilot/chat', {message: 'q'});
    assert.equal(res.bodyUsed, false);
    assert.equal(calls[0].url, 'http://localhost:3000/api/copilot/chat');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{"message":"q"}');
    assert.match(calls[0].init.headers.Accept, /text\/event-stream/);
  });

  test('postStream maps a refusal like a request (cost guard 503 with Retry-After, 401)', async () => {
    const err = await caught(client(respond(503, {error: 'This is temporarily unavailable. Try again shortly.', code: 'unavailable'}, {'retry-after': '60'})).api.postStream('/x', {}));
    assert.deepEqual([err.statusCode, err.errorCode, err.retryAfterS], [503, 'unavailable', 60]);
    const unauth = await caught(client(respond(401, {})).api.postStream('/x', {}));
    assert.deepEqual([unauth.statusCode, unauth.errorCode], [401, 'UNAUTHENTICATED']);
  });
});

describe('parseArgs', () => {
  test('reads positionals, --flag value, --flag=value, -c value and booleans', () => {
    const p = parseArgs(['a', '--wait', '--timeout=30', '-o', 'f.json'], {wait: {kind: 'bool'}, timeout: {kind: 'int', min: 1, max: 3600}, output: {kind: 'string', char: 'o'}}, 1);
    assert.deepEqual(p, {args: ['a'], flags: {wait: true, timeout: 30, output: 'f.json'}});
  });

  test('refuses unknown options, missing values, bad numbers, out-of-range and extra arguments', () => {
    const spec = {timeout: {kind: 'int', min: 1, max: 3600}, trigger: {kind: 'string', options: ['api', 'ci']}};
    for (const argv of [['--nope'], ['--timeout'], ['--timeout', 'x'], ['--timeout', '3601'], ['--trigger', 'cron'], ['a', 'b']]) {
      assert.throws(() => parseArgs(argv, spec, 1), UsageError, argv.join(' '));
    }
  });
});

describe('output helpers', () => {
  test('formatJson and formatDuration', () => {
    assert.equal(formatJson([1, 2, 3]), '[\n  1,\n  2,\n  3\n]');
    assert.equal(formatJson(null), 'null');
    assert.equal(formatDuration(500), '500ms');
    assert.equal(formatDuration(5000), '5.0s');
    assert.equal(formatDuration(125_000), '2m 5s');
  });
});

// --- copilot turn (ported from the console repo's copilot-turn tests)

const frame = (e, seq = 1) => `id: ${seq}\ndata: ${JSON.stringify({v: 1, runId: 'r', seq, eventId: `e${seq}`, ts: 0, ...e})}\n\n`;
function body(chunks, opts = {}) {
  const enc = new TextEncoder();
  const queue = [...chunks];
  return new ReadableStream({
    pull(c) {
      const next = queue.shift();
      if (next !== undefined) c.enqueue(enc.encode(next));
      else if (opts.fail) c.error(new TypeError('terminated'));
      else if (!opts.open) c.close();
      else return new Promise(() => {});
    },
  });
}

async function collect(b, deadlineMs, why) {
  const out = [];
  const stopped = await readEvents(b, e => out.push(e), deadlineMs);
  if (why) assert.equal(stopped, why);
  return out;
}

describe('readEvents', () => {
  test('parses frames split across chunks, CRLF, pings and skips junk data', async () => {
    const a = frame({type: 'tool', name: 'runs_list', status: 'done', label: 'Looked up runs'}, 1);
    const b = frame({type: 'final', text: 'hi', citations: [], sources: [], status: 'complete'}, 2).replace(/\n/g, '\r\n');
    const all = `: ping\n\n${a}data: not json\n\n${b}`;
    const events = await collect(body([all.slice(0, 17), all.slice(17, 60), all.slice(60)]));
    assert.deepEqual(events.map(e => e.type), ['tool', 'final']);
    assert.equal(events[1].text, 'hi');
  });

  test('stops at done and reads nothing after it', async () => {
    const events = await collect(body([frame({type: 'done', reason: 'complete'}, 1), frame({type: 'final', text: 'late', status: 'complete'}, 2)], {open: true}), undefined, 'done');
    assert.deepEqual(events.map(e => e.type), ['done']);
  });

  test('ends quietly on a dropped connection, keeping what arrived', async () => {
    const events = await collect(body([frame({type: 'tool', name: 'x', status: 'running'})], {fail: true}), undefined, 'dropped');
    assert.deepEqual(events.map(e => e.type), ['tool']);
  });

  test('stops on a frame that never ends instead of buffering it', async () => {
    assert.deepEqual(await collect(body([`data: ${'x'.repeat(1024 * 1024 + 1)}`], {open: true})), []);
  });

  test('stops at the deadline on a stream that never ends', async () => {
    assert.deepEqual(await collect(body([': ping\n\n'], {open: true}), 20, 'deadline'), []);
  });
});

describe('eventLine', () => {
  test('shows a finished or failed tool as one plain line, nothing while running', () => {
    assert.equal(eventLine({type: 'tool', name: 'runs_list', status: 'done', label: 'Looked up runs'}), '· Looked up runs');
    assert.equal(eventLine({type: 'tool', name: 'runs_list', status: 'done', title: 'Looking up runs'}), '· Looking up runs');
    assert.equal(eventLine({type: 'tool', name: 'runs_list', status: 'done'}), '· runs_list');
    assert.equal(eventLine({type: 'tool', name: 'runs_list', status: 'failed', label: 'Looked up runs'}), '· Looked up runs (failed)');
    assert.equal(eventLine({type: 'tool', name: 'runs_list', status: 'done', label: 'Read\nthe\tPR'}), '· Read the PR');
    assert.equal(eventLine({type: 'tool', name: 'runs_list', status: 'running'}), null);
    assert.equal(eventLine({type: 'token', text: 'x'}), null);
  });

  test('sends a card the CLI cannot answer to the console', () => {
    assert.equal(eventLine({type: 'interrupt', kind: 'read_approval', title: 'Read the PR\x1b[31m'}, 'c1'), '· Read the PR[31m: open the Zof console to answer this (conversation c1).');
    assert.equal(eventLine({type: 'interrupt', kind: 'choice'}), '· A question: open the Zof console to answer this.');
  });
});

describe('turnOutcome', () => {
  const final = (status, text = 'The answer') => ({type: 'final', text, citations: [], sources: [], status});
  test('answers with final.text on complete or no_answer', () => {
    assert.deepEqual(turnOutcome([final('complete')]), {answer: 'The answer', error: null, exit: 0});
    assert.equal(turnOutcome([final('no_answer', "That isn't covered in the help docs.")]).exit, 0);
  });

  test('shows an error event with its retryAfter and exits 1', () => {
    const e = {type: 'error', code: 'allowance_unavailable', message: "Copilot can't check your allowance right now.", recoverable: true, retryAfter: 30};
    assert.deepEqual(turnOutcome([e, {type: 'done', reason: 'error'}]), {answer: null, error: "Copilot can't check your allowance right now. Retry after 30s.", exit: 1});
  });

  test('exits 1 on a stopped turn, keeping any text, and on an empty answer', () => {
    assert.deepEqual(turnOutcome([final('timeout', 'partial')]), {answer: 'partial', error: 'Copilot stopped (timeout).', exit: 1});
    assert.equal(turnOutcome([final('complete', '')]).exit, 1);
  });

  test('says the turn is still running when the deadline stopped the read', () => {
    assert.deepEqual(turnOutcome([{type: 'start'}], 'deadline', 'c1'), {answer: null, error: 'Still running after 300s: see conversation c1 in the Zof console.', exit: 1});
    assert.equal(turnOutcome([{type: 'start'}], 'dropped', 'c1').error, 'No answer from Copilot.');
    assert.deepEqual(turnOutcome([{type: 'tool', name: 'x', status: 'done'}]), {answer: null, error: 'No answer from Copilot.', exit: 1});
  });

  test('cleans the answer and the error', () => {
    assert.equal(turnOutcome([final('complete', 'a\x1b[2Jb')]).answer, 'a[2Jb');
    assert.equal(turnOutcome([{type: 'error', code: 'unavailable', message: 'x\u009by'}]).error, 'xy');
  });

  test('thinking tokens never reach the answer, a line or --json', () => {
    const events = [{type: 'token', text: 'secret plan', kind: 'thinking'}, {type: 'token', text: 'Two'}, final('complete', 'Two runs failed.')];
    assert.equal(turnOutcome(events).answer, 'Two runs failed.');
    assert.deepEqual(events.map(e => eventLine(e)), [null, null, null]);
    assert.ok(!JSON.stringify(jsonEvents(events)).includes('secret plan'));
    assert.deepEqual(jsonEvents(events).map(e => e.type), ['final']);
  });

  test('cleanText drops C0 (but newline and tab), DEL and C1, and normalises CRLF', () => {
    assert.equal(cleanText('a\x1b[2Jb\u009bc\nd\te\r\nf\x7f\x07'), 'a[2Jbc\nd\te\nf');
  });
});

describe('copilot turn wiring', () => {
  const sse = events => new Response(events.map((e, i) => `id: ${i}\ndata: ${JSON.stringify({v: 1, seq: i, ...e})}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
  function fakeConsole(answer) {
    const calls = [];
    return {calls, api: {post: async (path, b) => { calls.push({path, body: b}); return {id: 'c1', title: 'x'}; }, stream: async (path, b) => { calls.push({path, body: b}); return answer; }}};
  }

  test('starts a titled conversation, then streams a turn in it', async () => {
    const fake = fakeConsole(sse([{type: 'start', conversationId: 'c1', messageId: 'm'}, {type: 'tool', name: 'runs_list', status: 'done', label: 'Looked up runs'}, {type: 'final', text: 'Two runs failed.', citations: [], sources: [], status: 'complete'}, {type: 'done', reason: 'complete'}]));
    const id = await startConversation(fake.api, conversationTitle('why did\nrun 7 fail?'));
    const seen = [];
    const {events, stopped} = await askTurn(fake.api, id, 'why did run 7 fail?', e => seen.push(e.type));
    assert.equal(stopped, 'done');
    assert.deepEqual(fake.calls, [
      {path: '/api/copilot/conversations', body: {title: 'CLI: why did run 7 fail?'}},
      {path: '/api/copilot/chat', body: {conversationId: 'c1', message: 'why did run 7 fail?', stream: true}},
    ]);
    assert.deepEqual(seen, ['start', 'tool', 'final', 'done']);
    assert.equal(events.length, 4);
  });

  test('titles with the first 60 characters, cleaned, never splitting an emoji', () => {
    assert.equal(conversationTitle(`${'a'.repeat(59)}😀😀`), `CLI: ${'a'.repeat(59)}😀`);
    assert.equal(conversationTitle(`\x1b[31m${'a'.repeat(80)}`), `CLI: [31m${'a'.repeat(56)}`);
  });

  test('gives no events for a non-stream answer, and refuses a conversation without an id', async () => {
    const fake = fakeConsole(new Response('{"events":[]}', {headers: {'content-type': 'application/json'}}));
    assert.deepEqual(await askTurn(fake.api, 'c1', 'q', () => {}), {events: [], stopped: 'end'});
    const err = await caught(startConversation({post: async () => ({}), stream: async () => new Response('')}, 't'));
    assert.equal(err.errorCode, 'bad_response');
  });

  test('errorHint turns the real refusals into one plain sentence', () => {
    assert.equal(errorHint(new ApiError(503, 'unavailable', 'This is temporarily unavailable. Try again shortly.', 'r', 60)), 'Copilot is temporarily unavailable. Retry after 60s.');
    assert.equal(errorHint(new ApiError(404, 'conversation_not_found', 'Conversation not found')), 'Conversation not found. Start a new one: zof copilot chat.');
    assert.equal(errorHint(new ApiError(404, 'conversation_not_found', 'Conversation not found'), true), 'Conversation not found. Your next message starts a new one.');
    assert.equal(errorHint(new ApiError(413, 'payload_too_large', 'The message is too long.')), 'The message is too long. Shorten the question.');
    assert.equal(errorHint(new ApiError(429, 'rate_limited', 'Too many questions at once. Try again in a minute.', 'r', 12)), 'Too many questions at once. Try again in a minute. Retry after 12s.');
    assert.equal(errorHint(new ApiError(503, 'not_configured', "Copilot isn't set up for this company yet.")), "Copilot isn't set up for this company yet.");
  });
});

// --- review (ported from the console repo's review-* tests)

const URL_ = 'https://console.test/code-review/rev_1';
const detail = (review, findings = []) => ({review: {review_id: 'rev_1', status: 'done', ...review}, findings});

describe('renderReview', () => {
  test('prints id, status, completeness, summary and counts, then the console link last', () => {
    const lines = renderReview(detail({complete: true, summary: 'Two issues.', counts_by_severity: {high: 2, critical: 1, low: 0}}), URL_);
    for (const l of ['ID: rev_1', 'Status: done', 'Complete: yes', 'Summary: Two issues.', 'Findings: critical 1 · high 2']) assert.ok(lines.includes(l), l);
    assert.equal(lines.at(-1), `Open in console: ${URL_}`);
  });

  test('says unknown for a null completeness, no for false, shows a failure reason, and none without counts', () => {
    assert.ok(renderReview(detail({complete: null}), URL_).includes('Complete: unknown'));
    const failed = renderReview(detail({status: 'failed', complete: false, failure_reason: 'clone failed'}), URL_);
    assert.ok(failed.includes('Complete: no') && failed.includes('Failure: clone failed'));
    assert.ok(renderReview(detail({}), URL_).includes('Findings: none'));
    assert.ok(renderReview(detail({counts_by_severity: {high: 0}}), URL_).includes('Findings: none'));
  });

  test('sorts findings by severity, keeping order within one, and places each', () => {
    const f = (severity, title) => ({severity, title});
    const sorted = renderReview(detail({}, [f('low', 'A'), f('critical', 'B'), f('info', 'C'), f('high', 'D'), f('medium', 'E'), f('high', 'F')]), URL_).filter(l => l.startsWith('['));
    assert.deepEqual(sorted, ['[critical] B', '[high] D', '[high] F', '[medium] E', '[low] A', '[info] C']);
    const placed = renderReview(detail({}, [
      {severity: 'high', title: 'S', source_location: {path: 'src/a.ts', line: 12}, location: {type: 'file', path: 'other.ts', line: 1}},
      {severity: 'high', title: 'F', location: {type: 'file', path: 'src/b.ts', line: 3}},
      {severity: 'high', title: 'N', location: {type: 'file', path: 'src/c.ts', line: null}},
      {severity: 'high', title: 'E', location: {type: 'endpoint', path: '/api/x'}},
      {severity: 'high', title: 'P', location: {type: 'package', name: 'lodash'}},
      {severity: 'high', title: 'X', location: null},
    ]), URL_).filter(l => l.startsWith('['));
    assert.deepEqual(placed, ['[high] S — src/a.ts:12', '[high] F — src/b.ts:3', '[high] N — src/c.ts', '[high] E — /api/x', '[high] P — lodash', '[high] X']);
  });

  test('drops escape and control characters from review text', () => {
    const lines = renderReview(detail({summary: 'a\nb\u001b[2Kc', failure_reason: 'x\u009by'}, [{severity: 'high', title: '\u001b]8;;https://evil\u0007Click', source_location: {path: 'src/\u001b[1Aa.ts', line: 1}}]), URL_);
    assert.ok(lines.includes('Summary: a b[2Kc'));
    assert.ok(lines.includes('Failure: xy'));
    assert.ok(lines.includes('[high] ]8;;https://evilClick — src/[1Aa.ts:1'));
    for (const l of lines) assert.doesNotMatch(l, /[\u0000-\u001f\u007f-\u009f]/);
  });

  test('reviewJson escapes C1 controls and stays the same JSON', () => {
    const data = {findings: [{severity: 'high', title: 'a\u009b2Jb\u007f', summary: 'x\u001by'}]};
    const out = reviewJson(data);
    assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    assert.ok(out.includes('a\\u009b2Jb\\u007f'));
    assert.deepEqual(JSON.parse(out), data);
  });

  test('renderNoAnswer says how to look later', () => {
    const lines = renderNoAnswer('rev_1', URL_);
    assert.match(lines.join('\n'), /No answer from the console before the timeout/);
    assert.ok(lines.includes('See it later: zof review show rev_1'));
    assert.equal(lines.at(-1), `Open in console: ${URL_}`);
  });
});

describe('startReview', () => {
  const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const target = {repo: 'acme/web', pr: 42};
  function fakeApi(ref, started = {review_id: 'rev_1', run_id: 'rrn_1'}) {
    const gets = [];
    const posts = [];
    return {gets, posts, api: {get: async path => { gets.push(path); if (ref instanceof Error) throw ref; return ref; }, post: async (...a) => { posts.push(a); if (started instanceof Error) throw started; return started; }}};
  }

  test('resolves the PR to a change, then starts one review with the idempotency key', async () => {
    const f = fakeApi({ref: {kind: 'pr', pr: 42, change_id: 'chg_1', head_sha: 'a'.repeat(40)}});
    assert.deepEqual(await startReview(f.api, target, KEY), {review_id: 'rev_1', run_id: 'rrn_1', change_id: 'chg_1'});
    assert.deepEqual(f.gets, ['/api/run/refs?repo=acme%2Fweb&ref=42']);
    assert.deepEqual(f.posts, [['/api/reviews', {change_id: 'chg_1'}, {'Idempotency-Key': KEY}]]);
  });

  test('refuses a ref that is not a pull request and starts nothing', async () => {
    for (const ref of [{ref: {kind: 'commit', head_sha: 'a'.repeat(40)}}, {ref: {kind: 'pr', pr: 42}}, {}]) {
      const f = fakeApi(ref);
      await assert.rejects(startReview(f.api, target, KEY), /did not resolve to a pull request/);
      assert.equal(f.posts.length, 0);
    }
  });

  test('passes a refs 4xx through and never posts; does not retry a rejected start', async () => {
    const err = new ApiError(404, 'pr_not_found', 'pr_not_found');
    const f = fakeApi(err);
    assert.equal(await caught(startReview(f.api, target, KEY)), err);
    assert.equal(f.posts.length, 0);
    const conflict = new ApiError(409, 'idempotency_conflict', 'idempotency_conflict');
    const g = fakeApi({ref: {kind: 'pr', pr: 42, change_id: 'chg_1'}}, conflict);
    assert.equal(await caught(startReview(g.api, target, KEY)), conflict);
    assert.equal(g.posts.length, 1);
  });

  test('reviewUrl links the console review page', () => {
    assert.equal(reviewUrl('https://console.zof.ai/', 'rev_X'), 'https://console.zof.ai/code-review/rev_X');
    assert.equal(reviewUrl('http://localhost:3000', 'rev_X'), 'http://localhost:3000/code-review/rev_X');
  });
});

describe('parsePrUrl', () => {
  test('accepts PR pages and their files/commits tabs', () => {
    for (const url of ['https://github.com/acme/web/pull/42', 'https://github.com/acme/web/pull/42/', 'https://github.com/acme/web/pull/42/files', 'https://github.com/acme/web/pull/42/files/', 'https://github.com/acme/web/pull/42/commits', 'https://GitHub.com/acme/web/pull/42']) {
      assert.deepEqual(parsePrUrl(url), {ok: true, repo: 'acme/web', pr: 42}, url);
    }

    assert.deepEqual(parsePrUrl('https://github.com/my-org_1/web.app/pull/7'), {ok: true, repo: 'my-org_1/web.app', pr: 7});
  });

  test('refuses anything else', () => {
    for (const url of ['http://github.com/a/b/pull/1', 'https://www.github.com/a/b/pull/1', 'https://gitlab.com/a/b/pull/1', 'https://github.example.com/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/1?x=1', 'https://github.com/a/b/pull/1#c', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/1/checks', 'https://github.com/a/b/pull/abc', 'https://u:p@github.com/a/b/pull/1', 'https://github.com:8443/a/b/pull/1', 'https://github.com/a b/c/pull/1', 'acme/web#42', '']) {
      const r = parsePrUrl(url);
      assert.equal(r.ok, false, url);
      assert.ok(r.message.includes(PR_URL_HELP));
    }
  });
});

describe('waitForReview', () => {
  const d = (status, complete = null) => ({review: {review_id: 'rev_1', status, complete}, findings: []});
  function clock() {
    let t = 0;
    const sleeps = [];
    return {now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; }, sleeps};
  }

  test('polls every 5 s until the review is done, or stops on failed', async () => {
    const c = clock();
    const answers = [d('queued'), d('reviewing'), d('done', true)];
    assert.deepEqual(await waitForReview(async () => answers.shift(), {timeoutMs: 900_000, now: c.now, sleep: c.sleep}), {detail: d('done', true), timedOut: false});
    assert.deepEqual(c.sleeps, [5000, 5000]);
    const out = await waitForReview(async () => d('failed'), {timeoutMs: 60_000, now: clock().now, sleep: clock().sleep});
    assert.deepEqual([out.timedOut, out.detail.review.status], [false, 'failed']);
  });

  test('times out with the last answer, never sleeping past the deadline, telling each fetch the time left', async () => {
    const c = clock();
    const left = [];
    const out = await waitForReview(async ms => { left.push(ms); return d('reviewing'); }, {timeoutMs: 12_000, now: c.now, sleep: c.sleep});
    assert.deepEqual(out, {detail: d('reviewing'), timedOut: true});
    assert.deepEqual(left, [12_000, 7000, 2000]);
    assert.ok(c.sleeps.reduce((a, b) => a + b, 0) <= 12_000);
  });

  test('keeps polling through transient errors (5xx, network, request timeout)', async () => {
    const c = clock();
    const steps = [() => { throw new ApiError(503, 'unavailable', 'u'); }, () => { throw new ApiError(0, 'NETWORK_ERROR', 'down'); }, () => { throw new ApiError(408, 'TIMEOUT', 'slow'); }, () => d('done', true)];
    assert.deepEqual(await waitForReview(async () => steps.shift()(), {timeoutMs: 60_000, now: c.now, sleep: c.sleep}), {detail: d('done', true), timedOut: false});
  });

  test('treats a 429 as transient and waits at least its Retry-After, capped by the time left', async () => {
    const c = clock();
    const steps = [() => { throw new ApiError(429, 'rate_limited', 'r', undefined, 20); }, () => d('done', true)];
    assert.deepEqual(await waitForReview(async () => steps.shift()(), {timeoutMs: 60_000, now: c.now, sleep: c.sleep}), {detail: d('done', true), timedOut: false});
    assert.deepEqual(c.sleeps, [20_000]);
    const c2 = clock();
    assert.deepEqual(await waitForReview(async () => { throw new ApiError(429, 'rate_limited', 'r', undefined, 120); }, {timeoutMs: 30_000, now: c2.now, sleep: c2.sleep}), {detail: null, timedOut: true});
    assert.deepEqual(c2.sleeps, [30_000]);
  });

  test('stops at once on an unreadable answer or a 4xx', async () => {
    for (const err of [new ApiError(0, 'UNKNOWN_ERROR', 'Unexpected token <'), new ApiError(404, 'not_found', 'not_found')]) {
      let calls = 0;
      const c = clock();
      assert.equal(await caught(waitForReview(async () => { calls++; throw err; }, {timeoutMs: 60_000, now: c.now, sleep: c.sleep})), err);
      assert.equal(calls, 1);
    }
  });

  test('reviewExitCode is 0 only for a done, complete review that did not time out', () => {
    assert.equal(reviewExitCode(d('done', true), false), 0);
    for (const [x, t] of [[d('done', false), false], [d('done', null), false], [d('failed', true), false], [d('reviewing'), false], [d('done', true), true], [null, true]]) assert.equal(reviewExitCode(x, t), 1);
  });
});

describe('runs create body', () => {
  test('sends the name as title, the trigger, branch, environment id and the target URL in metadata', () => {
    assert.deepEqual(buildRunCreateBody({name: 'Nightly Tests', trigger: 'ci', 'target-url': 'https://example.com', branch: 'main', environment: 'env_1'}), {title: 'Nightly Tests', trigger: 'ci', branch: 'main', environmentId: 'env_1', metadata: {targetUrl: 'https://example.com'}});
    assert.deepEqual(buildRunCreateBody({name: 'PR Check', trigger: 'api'}), {title: 'PR Check', trigger: 'api'});
    assert.deepEqual([...RUN_CREATE_TRIGGERS], ['manual', 'ci', 'scheduled', 'api']);
  });
});

describe('readSse (events stream)', () => {
  test('parses id/data frames, skips pings, junk and connected events', async () => {
    const seen = [];
    await readSse(body([': heartbeat 1\n\n', 'id: evt_1\ndata: {"type":"connected"}\n\n', 'id: evt_2\ndata: {"type":"run.started","entityId":"run_1"}\n\ndata: nope\n\n', 'data: {"type":"agent.dispatched","id":"own"}\n\n']), e => seen.push(e));
    assert.deepEqual(seen.map(e => [e.type, e.id]), [['run.started', 'evt_2'], ['agent.dispatched', 'own']]);
  });
});

describe('terminal output', () => {
  const ttyDeps = () => {
    const t = {writes: [], cancels: 0, exits: [], tick: null, sigint: null};
    t.deps = {
      raw: s => t.writes.push(s),
      every: fn => { t.tick = fn; return () => { t.cancels++; }; },
      onInterrupt: h => { t.sigint = h; return () => { t.sigint = null; }; },
      exit: c => t.exits.push(c),
    };
    return t;
  };
  const uni = {out() {}, err() {}, color: true, unicode: true, width: 80};
  const asc = {...uni, unicode: false};

  test('utf8Locale picks the first non-empty of LC_ALL, LC_CTYPE, LANG', () => {
    assert.equal(utf8Locale({LANG: 'en_US.UTF-8'}), true);
    assert.equal(utf8Locale({LC_ALL: 'C', LANG: 'en_US.UTF-8'}), false);
    assert.equal(utf8Locale({LANG: 'C.utf8'}), true);
    assert.equal(utf8Locale({}), false);
  });

  test('glyphs fall back to ASCII', () => {
    assert.equal(glyphs(asc).ok, 'ok');
    assert.equal(glyphs(asc).dot, '|');
    assert.equal(glyphs(asc).frames.join(''), '-\\|/');
    assert.equal(glyphs(uni).ok, '✔');
    assert.equal(glyphs(uni).rule, '─');
  });

  test('wrap is greedy, hard-splits long words and counts code points', () => {
    assert.deepEqual(wrap('a b  c', 3), ['a b', 'c']);
    assert.deepEqual(wrap('x'.repeat(7), 3), ['xxx', 'xxx', 'x']);
    assert.deepEqual(wrap('', 5), []);
    assert.deepEqual(wrap('abc', 0), ['a', 'b', 'c']);
    const long = 'the quick brown fox jumps over the lazy dog '.repeat(10);
    for (const l of wrap(long, 60)) assert.ok(l.length <= 60);
    for (const l of wrap('ab😀cd', 3)) assert.ok([...l].length <= 3);
    assert.ok(wrap('ab😀cd', 3).some(l => l.includes('😀')));
  });

  test('fit cuts with the marker', () => {
    assert.equal(fit('abcdef', 4, '…'), 'abc…');
    assert.equal(fit('ab', 4, '…'), 'ab');
  });

  test('elapsed shows whole seconds', () => {
    assert.equal(elapsed(0), '0s');
    assert.equal(elapsed(54_900), '54s');
    assert.equal(elapsed(72_000), '1m 12s');
    assert.equal(elapsed(-5000), '0s');
    assert.equal(elapsed(3_660_000), '61m 0s');
  });

  test('spinner animates, prints above itself and stops once', () => {
    const t = ttyDeps();
    const s = spinner(uni, t.deps, () => 'working');
    assert.ok(t.writes[0].includes('\x1b[?25l'));
    t.tick(); const a = t.writes.at(-1);
    t.tick(); const b = t.writes.at(-1);
    assert.ok(a.startsWith('\r\x1b[2K') && a.includes('working'));
    assert.notEqual(a, b);
    s.print('hi');
    const joined = t.writes.join('');
    assert.ok(joined.includes('\r\x1b[2Khi\n'));
    s.stop(); s.stop();
    assert.equal(t.writes.join('').split('\x1b[?25h').length - 1, 1);
    assert.equal(t.cancels, 1);
    assert.equal(t.sigint, null);
  });

  test('spinner restores the cursor and exits 130 on Ctrl+C', () => {
    const t = ttyDeps();
    spinner(uni, t.deps, () => 'x');
    t.sigint();
    assert.ok(t.writes.at(-1).includes('\x1b[?25h'));
    assert.deepEqual(t.exits, [130]);
  });

  test('ascii spinner uses only ASCII frames', () => {
    const t = ttyDeps();
    spinner(asc, t.deps, () => 'x');
    for (let i = 0; i < 5; i++) { t.tick(); assert.match(t.writes.at(-1), /^\r\x1b\[2K  [-\\|/] x$/); }
  });
});
