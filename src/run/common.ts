/** What `zof login`, `zof run` and `zof logout` share: their seams, the sign-in record and one guarded console call. */
import {EXIT, type ExitCode} from '../gate/exit.js';
import type {HttpClient, HttpResponse} from '../gate/http.js';
import {redact} from '../gate/redact.js';
import type {SecretStore, Spawn} from './keychain.js';

export interface RunDeps {
  version: string;
  env: Record<string, string | undefined>;
  http: HttpClient;
  /** The OS keychain, or null when none is usable (then nothing is stored anywhere). */
  store: () => Promise<SecretStore | null>;
  spawn: Spawn;
  /** Wall-clock milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  uuid: () => string;
  write: (stream: 'out' | 'err', line: string) => void;
  /** Whether stdin is a terminal a person can answer at. */
  interactive: boolean;
  /** One line from the person, or null at end of input. */
  ask: (question: string) => Promise<string | null>;
  /** Calls `handler` on Ctrl-C until the returned function is called. */
  onInterrupt: (handler: () => void) => () => void;
}

export class Stop extends Error {
  constructor(readonly exit: ExitCode, readonly detail: string, readonly code?: string) { super(detail); }
}
export const usage = (detail: string) => new Stop(EXIT.config, detail);

export const CLIENT_ID = 'zof-cli-app';
export const RUNS_SCOPE = 'runs';
const TOKEN = /^zofcli_[A-Za-z0-9_-]{16,512}$/;

/** What the keychain holds: the token, the console it belongs to and when it stops working. */
export interface SignIn {v: 1; console: string; token: string; expires_at: number}

export function readSignIn(raw: string | null): SignIn | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SignIn>;
    if (v.v !== 1 || typeof v.token !== 'string' || !TOKEN.test(v.token) || typeof v.console !== 'string' || typeof v.expires_at !== 'number') return null;
    return {v: 1, console: consoleBase(v.console), token: v.token, expires_at: v.expires_at};
  } catch {
    return null;
  }
}

export const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

/** The console's origin: https, or http only on this machine; never credentials, a query or a fragment. */
export function consoleBase(raw: string | undefined): string {
  if (!raw) throw usage('No Zof console address. Pass --console-url https://<your Zof console>, or set ZOF_CONSOLE_URL.');
  let url: URL;
  try { url = new URL(raw); } catch { throw usage('The Zof console address is not a valid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw usage('The Zof console address must use https.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw usage('The Zof console address must be just its origin, like https://console.example.com.');
  return url.origin;
}

/** Strips control characters (no terminal escapes) and bidi or zero-width marks (no text that reads differently), then bounds the length. */
export function clean(value: unknown, max = 300): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

export function printer(deps: RunDeps, secrets: readonly string[], json: boolean) {
  return (line: string) => deps.write(json ? 'err' : 'out', redact(line, secrets));
}

const MAX_ATTEMPTS = 4;
export interface Call {method: 'GET' | 'POST'; path: string; body?: unknown; token?: string; idempotencyKey?: string; timeoutMs?: number}
export interface Answer {status: number; body: Record<string, unknown>}

/** One console call: outages and 429s are retried (honouring Retry-After), then they are Zof's side (exit 3). */
export async function callConsole(deps: RunDeps, base: string, call: Call): Promise<Answer> {
  const headers: Record<string, string> = {accept: 'application/json', 'user-agent': `zof-cli/${deps.version}`};
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;
  let why = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let wait: number | undefined;
    try {
      const r = await deps.http({method: call.method, url: base + call.path, headers, ...(call.body !== undefined ? {body: JSON.stringify(call.body)} : {}), timeoutMs: call.timeoutMs ?? 30_000});
      if (r.status !== 408 && r.status !== 429 && r.status < 500) return {status: r.status, body: parse(r)};
      why = `HTTP ${r.status}`;
      wait = retryAfter(r);
    } catch (error) {
      why = `no answer (${clean((error as Error)?.message ?? error, 120)})`;
    }
    if (attempt === MAX_ATTEMPTS - 1) break;
    await deps.sleep(wait ?? Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw new Stop(EXIT.unavailable, `Zof is unavailable right now (${why}). Nothing more was done; try again in a few minutes.`, 'unavailable');
}

function parse(r: HttpResponse): Record<string, unknown> {
  try {
    const v = JSON.parse(r.text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function retryAfter(r: HttpResponse): number | undefined {
  const v = r.headers['retry-after'];
  return v && /^[0-9]{1,4}$/.test(v.trim()) ? Math.min(Number(v.trim()), 60) * 1000 : undefined;
}

/** A refusal's code, from a `{code}` or `{error}` body, as a short slug. */
export function codeOf(a: Answer): string {
  const raw = typeof a.body.code === 'string' ? a.body.code : typeof a.body.error === 'string' ? a.body.error : `http_${a.status}`;
  return clean(raw, 64).replace(/[^A-Za-z0-9_.:-]/g, '_') || `http_${a.status}`;
}

/** 401 is the sign-in (exit 4); any other 4xx is a refusal with its code (exit 2). */
export function refused(a: Answer, what: string): Stop {
  const code = codeOf(a);
  if (a.status === 401) return new Stop(EXIT.token, 'Zof did not accept your sign-in (it expired or was revoked). Run zof login.', code);
  return new Stop(EXIT.config, `Zof refused ${what} (code: ${code}).`, code);
}

export function finish(say: (line: string) => void, error: unknown): ExitCode {
  if (error instanceof Stop) { say(error.detail); return error.exit; }
  say(`zof stopped on an unexpected problem (${clean((error as Error)?.message ?? error, 160)}). Nothing more was done.`);
  return EXIT.unavailable;
}
