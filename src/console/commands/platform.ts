import {consoleOrigin, terminalJson} from '../api.js';
import {required, type Command, type Ctx} from '../context.js';
import {banner, errorLine, formatJson, formatStatus, info, paint, table, warn} from '../output.js';
import {connectSse, type SseEvent} from '../sse.js';

const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** Streams until Ctrl+C or the server closes; the line printer decides what each event shows. */
async function stream(ctx: Ctx, topics: string[] | undefined, title: string, show: (e: SseEvent) => string | null): Promise<number> {
  const client = await ctx.authed();
  const {o} = ctx;
  const started = ctx.deps.now();
  let count = 0;
  const controller = new AbortController();
  const off = ctx.deps.onInterrupt(() => controller.abort());
  if (!ctx.json) { o.out(''); o.out(paint(o, 'bold', `  ${title}`) + paint(o, 'dim', ' (Ctrl+C to stop)')); if (topics) info(o, `Topics: ${topics.join(',')}`); o.out(''); }
  try {
    await connectSse(client, '/api/events/stream', {
      topics,
      onConnect: () => { if (!ctx.json) info(o, 'Connected to event stream'); },
      onEvent: e => {
        const line = show(e);
        if (line === null) return;
        count++;
        o.out(ctx.json ? terminalJson(e) : line);
      },
      onDisconnect: () => { if (!ctx.json && !controller.signal.aborted) warn(o, 'Disconnected from event stream'); },
      onError: err => errorLine(o, `Stream error: ${err.message}`),
    }, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    off();
  }

  if (!ctx.json) info(o, `Received ${count} events in ${Math.round((ctx.deps.now() - started) / 1000)}s`);
  return controller.signal.aborted ? 0 : 1;
}

const time = (e: SseEvent): string => (e.createdAt ? new Date(e.createdAt).toLocaleTimeString() : '');
const topicsOf = (v: unknown): string[] | undefined => (typeof v === 'string' ? v.split(',').map(t => t.trim()).filter(Boolean) : undefined);

const runsStream: Command = {
  usage: 'zof runs stream <run-id> [--topics runs,agents] [--json]',
  summary: 'Stream live activity for a run',
  args: ['run-id'],
  flags: {topics: {kind: 'string'}},
  run(ctx, p) {
    const runId = required(p, 0, 'run ID');
    return stream(ctx, topicsOf(p.flags.topics) ?? ['runs', 'agents'], `Streaming run ${runId}...`, e => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      if (payload.run_id !== runId && e.entityId !== runId) return null;
      const detail = [s(payload.agent_key), s(payload.message), payload.findings_count !== undefined ? `${s(payload.findings_count)} findings` : ''].filter(Boolean).join(' - ');
      return `  ${paint(ctx.o, 'dim', time(e))}  ${formatStatus(ctx.o, s(e.type).padEnd(24))}  ${detail}`;
    });
  },
};

const eventsStream: Command = {
  usage: 'zof events stream [--topics a,b] [--json]',
  summary: 'Stream live platform events',
  flags: {topics: {kind: 'string'}},
  run(ctx, p) {
    return stream(ctx, topicsOf(p.flags.topics), 'Streaming events...', e => `  ${paint(ctx.o, 'dim', time(e))}  ${formatStatus(ctx.o, s(e.type).padEnd(28))}${e.entityId ? ` [${s(e.entityId).slice(0, 12)}]` : ''}`);
  },
};

const status: Command = {
  usage: 'zof services status [--json]',
  summary: 'Show platform service health',
  async run(ctx) {
    const start = ctx.deps.now();
    const r = await ctx.client().get<{status?: string; services?: Array<{name: string; status: string; latency?: number}>}>('/api/health', {requireAuth: false});
    const latency = Math.round(ctx.deps.now() - start);
    if (ctx.json) { ctx.o.out(formatJson({...r, response_time_ms: latency})); return 0; }
    banner(ctx.o, 'Platform Status');
    if (r.services?.length) ctx.o.out(table(ctx.o, ['Service', 'Status', 'Latency'], r.services.map(x => [s(x.name), formatStatus(ctx.o, s(x.status)), x.latency ? `${x.latency}ms` : '-'])));
    else { ctx.o.out(`  Platform: ${formatStatus(ctx.o, r.status || 'unknown')}`); ctx.o.out(`  Response time: ${latency}ms`); }
    return 0;
  },
};

const ping: Command = {
  usage: 'zof services ping [--json]',
  summary: 'Check that the console answers (exit 1 if it cannot be reached)',
  async run(ctx) {
    const url = consoleOrigin(ctx.consoleUrl());
    const start = ctx.deps.now();
    let statusCode: number | null = null;
    try {
      statusCode = (await ctx.deps.fetch(`${url}/api/health`, {signal: AbortSignal.timeout(10_000), redirect: 'manual'})).status;
    } catch {
      // Unreachable: reported below.
    }

    const latency = Math.round(ctx.deps.now() - start);
    const reachable = statusCode !== null && statusCode >= 200 && statusCode < 300;
    if (ctx.json) { ctx.o.out(formatJson({url, ...(statusCode === null ? {} : {status: statusCode}), latency_ms: latency, reachable})); return statusCode === null ? 1 : 0; }
    banner(ctx.o, 'Ping');
    if (statusCode === null) {
      errorLine(ctx.o, `Cannot reach the Zof console at ${url}`);
      info(ctx.o, 'Check ZOF_CONSOLE_URL or run `zof config set console_url <url>`');
      return 1;
    }

    ctx.o.out(reachable ? `  ${paint(ctx.o, 'green', 'ok')} Console reachable at ${url}` : `  ${paint(ctx.o, 'yellow', '!')} Console answered HTTP ${statusCode}`);
    info(ctx.o, `Response time: ${latency}ms`);
    return 0;
  },
};

export const SERVICES: Record<string, Command> = {status, ping};
export const EVENTS: Record<string, Command> = {stream: eventsStream};
export const RUNS_STREAM = runsStream;
