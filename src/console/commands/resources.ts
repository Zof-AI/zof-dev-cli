import {ApiError, consoleOrigin} from '../api.js';
import {UsageError, type Parsed} from '../args.js';
import {required, seg, type Command, type Ctx} from '../context.js';
import {banner, formatDuration, formatJson, formatStatus, formatTimestamp, info, keyValue, success, table} from '../output.js';
import {buildRunCreateBody, RUN_CREATE_TRIGGERS} from '../run-create-body.js';

type Row = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const short = (v: unknown): string => (s(v).length > 15 ? `${s(v).slice(0, 12)}...` : s(v) || '-');
const pct = (v: unknown): string | undefined => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : undefined);
const kb = (v: unknown): string | undefined => (typeof v === 'number' && v > 0 ? `${(v / 1024).toFixed(1)} KB` : undefined);
const query = (pairs: Record<string, unknown>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) if (v !== undefined) q.set(k, String(v));
  const t = q.toString();
  return t ? `?${t}` : '';
};

function emit(ctx: Ctx, data: unknown): boolean {
  if (ctx.json) ctx.o.out(formatJson(data));
  return ctx.json;
}

// --- agents

const agentsList: Command = {
  usage: 'zof agents list [--category KEY] [--family NAME] [--class NAME] [--json]',
  summary: 'List available agents',
  flags: {category: {kind: 'string'}, family: {kind: 'string'}, class: {kind: 'string'}},
  async run(ctx, p) {
    const r = await (await ctx.authed()).get<{data?: Row[]; agents?: Row[]}>(`/api/ai-agents${query({category: p.flags.category, family: p.flags.family, class: p.flags.class})}`);
    const agents = r.data || r.agents || [];
    if (emit(ctx, agents)) return 0;
    banner(ctx.o, 'Agents');
    if (!agents.length) { ctx.o.out('  No agents found.'); return 0; }
    ctx.o.out(table(ctx.o, ['Key', 'Name', 'Class', 'Category', 'Status'], agents.map(a => [s(a.key), s(a.name), s(a.agent_class) || '-', s(a.category_key) || '-', formatStatus(ctx.o, s(a.status) || s(a.maturity) || 'active')])));
    ctx.o.out(`\n  ${agents.length} agents`);
    return 0;
  },
};

const agentsShow: Command = {
  usage: 'zof agents show <key> [--json]',
  summary: 'Show an agent',
  args: ['key'],
  async run(ctx, p) {
    const key = required(p, 0, 'agent key');
    const r = await (await ctx.authed()).get<{data?: Row; agent?: Row}>(`/api/ai-agents/${seg(key)}`);
    const a = r.data || r.agent;
    if (!a) { ctx.o.err(`  Agent not found: ${key}`); return 1; }
    if (emit(ctx, a)) return 0;
    banner(ctx.o, `Agent: ${s(a.name)}`);
    keyValue(ctx.o, [['Key', s(a.key)], ['Name', s(a.name)], ['Description', s(a.description)], ['Class', s(a.agent_class)], ['Category', s(a.category_key)], ['Family', s(a.family)], ['Maturity', s(a.maturity)],
      ['Service Group', s((a.runtime as Row | undefined)?.service_group) || undefined], ['Health Check', s((a.deployment as Row | undefined)?.health_check) || undefined]]);
    if (Array.isArray(a.capabilities) && a.capabilities.length) { ctx.o.out('\n  Capabilities:'); for (const c of a.capabilities) ctx.o.out(`    - ${s(c)}`); }
    return 0;
  },
};

const agentsHealth: Command = {
  usage: 'zof agents health <key> [--json]',
  summary: 'Show the health of an agent',
  args: ['key'],
  async run(ctx, p) {
    const key = required(p, 0, 'agent key');
    const r = await (await ctx.authed()).get<{data?: Row} & Row>(`/api/ai-agents/${seg(key)}`);
    const a = r.data || r;
    if (emit(ctx, a)) return 0;
    banner(ctx.o, `Agent Health: ${key}`);
    keyValue(ctx.o, [['Agent', key], ['Status', formatStatus(ctx.o, s(a.status) || 'unknown')]]);
    return 0;
  },
};

// The console's start-run validator (POST /api/ai-agents/{key}/runs): checked here first so a typo is a usage error.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// dash's address gate (server/address-proof/gate.ts): a heavy agent's run needs a confirmed, proven address.
const ADDRESS_GATE = new Set(['confirmation_required', 'address_not_verified']);
const flag = (p: Parsed, name: string, test: RegExp, hint: string): string => {
  const v = p.flags[name];
  if (typeof v !== 'string' || !test.test(v)) throw new UsageError(`--${name} ${hint}.`);
  return v;
};

const agentsRun: Command = {
  usage: 'zof agents run <key> --repo OWNER/NAME --commit SHA --capability KIND [--target-url URL] [--config JSON] [--yes] [--json]',
  summary: 'Start a run of an agent on a commit (uses credits; asks first, or pass --yes)',
  args: ['key'],
  flags: {repo: {kind: 'string'}, commit: {kind: 'string'}, capability: {kind: 'string'}, 'target-url': {kind: 'string'}, config: {kind: 'string'}, yes: {kind: 'bool'}},
  async run(ctx, p) {
    const key = required(p, 0, 'agent key');
    const repo = flag(p, 'repo', REPO, 'must be OWNER/NAME, e.g. acme/web');
    const commit = flag(p, 'commit', COMMIT, 'must be a full 40-character commit SHA');
    const capability = flag(p, 'capability', KIND, 'must be a capability key, e.g. performance');
    let config: unknown = {};
    if (p.flags.config !== undefined) {
      try { config = JSON.parse(String(p.flags.config)); } catch { throw new UsageError('Invalid JSON in --config.'); }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new UsageError('--config must be a JSON object.');
    }

    const yes = p.flags.yes === true;
    const {ask} = ctx.deps;
    if (!yes && !ask) throw new UsageError('stdin is not a terminal, so zof agents run cannot ask before starting. Pass --yes to start the run.');

    const targetUrl = p.flags['target-url'];
    const body = {repo, commit, capability, config, ...(targetUrl !== undefined ? {target_url: String(targetUrl)} : {})};
    const client = await ctx.authed();
    const origin = consoleOrigin(client.baseUrl);
    // It spends credits: say so and ask, in zof run's words. No route prices a single agent run, so no amount is shown.
    const say = (line: string) => (ctx.json ? ctx.o.err(line) : ctx.o.out(line));
    say(`  Run ${key} on ${repo} @ ${commit.slice(0, 7)}`);
    say('  Price: a price Zof will show you');
    if (!yes) {
      const reply = (await ask!('Continue? [y/N] '))?.trim().toLowerCase();
      if (reply !== 'y' && reply !== 'yes') { say('  Not started.'); return 0; }
    }

    let r: Row;
    try {
      // One key per invocation: a retried request never starts (or bills) a second run.
      r = await client.post<Row>(`/api/ai-agents/${seg(key)}/runs`, body, {headers: {'Idempotency-Key': ctx.deps.uuid()}});
    } catch (error) {
      // The address gate (a heavy agent): its codes, never its text.
      if (error instanceof ApiError && error.statusCode === 403 && ADDRESS_GATE.has(error.serverCode ?? '')) {
        throw new ApiError(403, error.errorCode, `This agent needs a confirmed address; start it in the console: ${origin}/ai-agents/${encodeURIComponent(key)}`, error.requestId, undefined, error.serverCode);
      }
      throw error;
    }
    if (emit(ctx, r)) return 0;
    success(ctx.o, 'Run started');
    keyValue(ctx.o, [['Agent', key], ['Run ID', s(r.run_id) || '-'], ['Repo', repo], ['Commit', commit.slice(0, 12)]]);
    if (r.run_id) info(ctx.o, `Open in console: ${origin}/runs/${encodeURIComponent(s(r.run_id))}`);
    return 0;
  },
};

// --- runs

const runsList: Command = {
  usage: 'zof runs list [--status STATUS] [--limit N] [--page N] [--json]',
  summary: 'List runs',
  flags: {status: {kind: 'string'}, limit: {kind: 'int', min: 1, max: 500}, page: {kind: 'int', min: 1}},
  async run(ctx, p) {
    const r = await (await ctx.authed()).get<{data?: {runs?: Row[]; total?: number}}>(`/api/runs${query({status: p.flags.status, limit: p.flags.limit ?? 25, page: p.flags.page ?? 1})}`);
    const runs = r.data?.runs || [];
    if (emit(ctx, r.data)) return 0;
    banner(ctx.o, 'Runs');
    if (!runs.length) { ctx.o.out('  No runs found.'); return 0; }
    ctx.o.out(table(ctx.o, ['ID', 'Name', 'Status', 'Trigger', 'Created'], runs.map(x => [short(x.id), s(x.title) || s(x.name) || '-', formatStatus(ctx.o, s(x.status)), s(x.trigger) || '-', formatTimestamp(s(x.createdAt))])));
    ctx.o.out(`\n  Showing ${runs.length} of ${r.data?.total || runs.length} runs`);
    return 0;
  },
};

const runsShow: Command = {
  usage: 'zof runs show <run-id> [--json]',
  summary: 'Show a run',
  args: ['run-id'],
  async run(ctx, p) {
    const id = required(p, 0, 'run ID');
    const run = (await (await ctx.authed()).get<{data?: Row}>(`/api/runs/${seg(id)}`)).data;
    if (!run) { ctx.o.err(`  Run not found: ${id}`); return 1; }
    if (emit(ctx, run)) return 0;
    const duration = run.startedAt && run.completedAt ? formatDuration(new Date(s(run.completedAt)).getTime() - new Date(s(run.startedAt)).getTime()) : undefined;
    banner(ctx.o, `Run: ${s(run.title) || s(run.name) || id}`);
    keyValue(ctx.o, [['ID', s(run.id)], ['Name', s(run.title) || s(run.name)], ['Status', formatStatus(ctx.o, s(run.status))], ['Trigger', s(run.trigger)], ['Branch', s(run.branch) || undefined], ['Environment', s(run.environment) || undefined],
      ['Created', formatTimestamp(s(run.createdAt))], ['Started', formatTimestamp(s(run.startedAt))], ['Completed', formatTimestamp(s(run.completedAt))], ['Duration', duration]]);
    if (Array.isArray(run.agentRuns) && run.agentRuns.length) {
      ctx.o.out('\n  Agent Runs:');
      for (const ar of run.agentRuns as Row[]) ctx.o.out(`    ${formatStatus(ctx.o, s(ar.status))}  ${s(ar.agentKey)}`);
    }

    return 0;
  },
};

const runsCreate: Command = {
  usage: `zof runs create --name NAME [--trigger ${RUN_CREATE_TRIGGERS.join('|')}] [--target-url URL] [--branch NAME] [--environment ID] [--json]`,
  summary: 'Create a run',
  flags: {name: {kind: 'string'}, trigger: {kind: 'string', options: RUN_CREATE_TRIGGERS}, 'target-url': {kind: 'string'}, branch: {kind: 'string'}, environment: {kind: 'string'}},
  async run(ctx, p) {
    if (typeof p.flags.name !== 'string') throw new UsageError('--name is required.');
    const body = buildRunCreateBody({name: p.flags.name, trigger: (p.flags.trigger as string | undefined) ?? 'api', 'target-url': p.flags['target-url'] as string | undefined, branch: p.flags.branch as string | undefined, environment: p.flags.environment as string | undefined});
    const run = (await (await ctx.authed()).post<{data: Row}>('/api/runs', body)).data;
    if (emit(ctx, run)) return 0;
    success(ctx.o, `Run created: ${s(run.id)}`);
    keyValue(ctx.o, [['ID', s(run.id)], ['Name', s(run.title)], ['Status', s(run.status)]]);
    info(ctx.o, `Stream progress: zof runs stream ${s(run.id)}`);
    return 0;
  },
};

const runsCancel: Command = {
  usage: 'zof runs cancel <run-id> [--json]',
  summary: 'Cancel an active run',
  args: ['run-id'],
  async run(ctx, p) {
    const id = required(p, 0, 'run ID');
    const r = await (await ctx.authed()).put(`/api/runs/${seg(id)}`, {status: 'cancelled'});
    if (emit(ctx, r)) return 0;
    success(ctx.o, `Run ${id} cancelled`);
    return 0;
  },
};

// --- artifacts (by engine run)

async function artifactsOf(ctx: Ctx, runId: unknown): Promise<Row[]> {
  if (typeof runId !== 'string') throw new UsageError('--run-id is required.');
  const r = await (await ctx.authed()).get<{data?: Row[]; artifacts?: Row[]} | Row[]>(`/api/engine-runs/${seg(runId)}/artifacts`);
  return Array.isArray(r) ? r : r.data || r.artifacts || [];
}

const artifactsList: Command = {
  usage: 'zof artifacts list --run-id ID [--json]',
  summary: 'List the artifacts of an engine run',
  flags: {'run-id': {kind: 'string'}},
  async run(ctx, p) {
    const list = await artifactsOf(ctx, p.flags['run-id']);
    if (emit(ctx, list)) return 0;
    banner(ctx.o, 'Artifacts');
    if (!list.length) { ctx.o.out('  No artifacts found.'); return 0; }
    ctx.o.out(table(ctx.o, ['ID', 'Name', 'Type', 'Size', 'Created'], list.map(a => [short(a.id), s(a.name) || '-', s(a.type) || '-', kb(a.size) ?? '-', formatTimestamp(s(a.createdAt))])));
    ctx.o.out(`\n  ${list.length} artifacts`);
    return 0;
  },
};

const artifactsShow: Command = {
  usage: 'zof artifacts show <artifact-id> --run-id ID [--json]',
  summary: 'Show an artifact',
  args: ['artifact-id'],
  flags: {'run-id': {kind: 'string'}},
  async run(ctx, p) {
    const id = required(p, 0, 'artifact ID');
    const a = (await artifactsOf(ctx, p.flags['run-id'])).find(x => x.id === id);
    if (!a) { ctx.o.err(`  Artifact not found: ${id}`); return 1; }
    if (emit(ctx, a)) return 0;
    banner(ctx.o, `Artifact: ${s(a.name) || id}`);
    keyValue(ctx.o, [['ID', s(a.id)], ['Name', s(a.name)], ['Type', s(a.type)], ['Size', kb(a.size)], ['Created', formatTimestamp(s(a.createdAt))]]);
    if (a.content) { ctx.o.out('\n  Content:'); ctx.o.out(`    ${typeof a.content === 'string' ? a.content : formatJson(a.content)}`); }
    return 0;
  },
};

const artifactsDownload: Command = {
  usage: 'zof artifacts download <artifact-id> --run-id ID [--output FILE]',
  summary: 'Save an artifact to a local file (default artifact.json)',
  args: ['artifact-id'],
  flags: {'run-id': {kind: 'string'}, output: {kind: 'string', char: 'o'}},
  async run(ctx, p) {
    const id = required(p, 0, 'artifact ID');
    const a = (await artifactsOf(ctx, p.flags['run-id'])).find(x => x.id === id);
    if (!a) { ctx.o.err(`  Artifact not found: ${id}`); return 1; }
    const out = (p.flags.output as string | undefined) ?? 'artifact.json';
    const content = typeof a === 'string' ? a : formatJson(a);
    ctx.deps.writeFile(out, content);
    success(ctx.o, `Artifact saved to ${out}`);
    info(ctx.o, `Size: ${Buffer.byteLength(content)} bytes`);
    return 0;
  },
};

// --- approvals (remediation plans)

const approvalsList: Command = {
  usage: 'zof approvals list [--status pending|approved|rejected|applied] [--json]',
  summary: 'List remediation plans',
  flags: {status: {kind: 'string', options: ['pending', 'approved', 'rejected', 'applied']}},
  async run(ctx, p) {
    const r = await (await ctx.authed()).get<{data?: Row[]; plans?: Row[]}>(`/api/remediation/plans${query({status: p.flags.status})}`);
    const plans = r.data || r.plans || [];
    if (emit(ctx, plans)) return 0;
    banner(ctx.o, 'Approvals');
    if (!plans.length) { ctx.o.out('  No remediation plans found.'); return 0; }
    ctx.o.out(table(ctx.o, ['ID', 'Title', 'Status', 'Agent', 'Confidence', 'Created'], plans.map(x => [short(x.id), s(x.title) || '-', formatStatus(ctx.o, s(x.status)), s(x.agentKey) || '-', pct(x.confidence) ?? '-', formatTimestamp(s(x.createdAt))])));
    ctx.o.out(`\n  ${plans.length} plans`);
    return 0;
  },
};

const approvalsShow: Command = {
  usage: 'zof approvals show <plan-id> [--json]',
  summary: 'Show a remediation plan',
  args: ['plan-id'],
  async run(ctx, p) {
    const id = required(p, 0, 'plan ID');
    const r = await (await ctx.authed()).get<{data?: Row} & Row>(`/api/remediation/plans/${seg(id)}`);
    const plan = r.data || r;
    if (emit(ctx, plan)) return 0;
    banner(ctx.o, `Remediation Plan: ${s(plan.title) || id}`);
    keyValue(ctx.o, [['ID', s(plan.id)], ['Title', s(plan.title) || undefined], ['Status', formatStatus(ctx.o, s(plan.status))], ['Agent', s(plan.agentKey) || undefined], ['Finding ID', s(plan.findingId) || undefined], ['Confidence', pct(plan.confidence)], ['Created', formatTimestamp(s(plan.createdAt))]]);
    if (Array.isArray(plan.patches) && plan.patches.length) {
      ctx.o.out('\n  Patches:');
      for (const patch of plan.patches as Row[]) {
        ctx.o.out(`    - ${s(patch.file)}`);
        if (patch.diff) ctx.o.out(`      ${s(patch.diff).slice(0, 200)}${s(patch.diff).length > 200 ? '...' : ''}`);
      }
    }

    return 0;
  },
};

const decide = (verb: 'approve' | 'reject'): Command => ({
  usage: `zof approvals ${verb} <plan-id> [--reason TEXT] [--json]`,
  summary: `${verb === 'approve' ? 'Approve' : 'Reject'} a remediation plan`,
  args: ['plan-id'],
  flags: {reason: {kind: 'string'}},
  async run(ctx, p) {
    const id = required(p, 0, 'plan ID');
    const r = await (await ctx.authed()).post(`/api/remediation/plans/${seg(id)}/${verb}`, {reason: p.flags.reason, source: 'cli'});
    if (emit(ctx, r)) return 0;
    success(ctx.o, `Plan ${id} ${verb === 'approve' ? 'approved' : 'rejected'}`);
    return 0;
  },
});

export const AGENTS: Record<string, Command> = {list: agentsList, show: agentsShow, health: agentsHealth, run: agentsRun};
export const RUNS: Record<string, Command> = {list: runsList, show: runsShow, create: runsCreate, cancel: runsCancel};
export const ARTIFACTS: Record<string, Command> = {list: artifactsList, show: artifactsShow, download: artifactsDownload};
export const APPROVALS: Record<string, Command> = {list: approvalsList, show: approvalsShow, approve: decide('approve'), reject: decide('reject')};
