import type {GateAnswer} from './types.js';

export interface Expect {repo: string; commit_sha: string; environment: string; gate_id?: string; breakGlass?: boolean}
export type Parsed = {ok: true; answer: GateAnswer} | {ok: false; why: string};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const strOrNull =(v: unknown) => v === null || v === undefined || typeof v === 'string';

/** Parses a gate.v1 answer and checks it is about this request. Anything else is "no answer". */
export function parseAnswer(text: string, expect: Expect): Parsed {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return {ok: false, why: 'the answer was not JSON'}; }
  if (!isObj(v)) return {ok: false, why: 'the answer was not an object'};
  if (v.schema_version !== 1 || v.kind !== 'gate_check') return {ok: false, why: 'the answer is not a gate.v1 answer'};
  if (typeof v.gate_id !== 'string' || !/^gate_[0-9a-f]{32}$/.test(v.gate_id)) return {ok: false, why: 'the answer has no valid gate_id'};
  if (expect.gate_id && v.gate_id !== expect.gate_id) return {ok: false, why: 'the answer is for another gate check'};
  // GitHub owner/name are case-insensitive; the commit and environment stay exact.
  if (typeof v.repo !== 'string' || v.repo.toLowerCase() !== expect.repo.toLowerCase() || v.commit_sha !== expect.commit_sha || v.environment !== expect.environment) return {ok: false, why: 'the answer is for another repository, commit or environment'};
  const final = v.state === 'final';
  if (!(v.state === 'waiting' || final)) return {ok: false, why: 'the answer has an unknown state'};
  if (final ? !(v.result === 'pass' || v.result === 'fail') : v.result !== 'waiting') return {ok: false, why: 'the answer state and result disagree'};
  // Held to release_gate.v1's required fields; a body that fails the schema is no answer (exit 3).
  for (const k of ['tenant_id', 'correlation_id'] as const) if (typeof v[k] !== 'string') return {ok: false, why: `the answer has no ${k}`};
  if (typeof v.answered_at !== 'string' || !DATE_TIME.test(v.answered_at) || !Number.isFinite(Date.parse(v.answered_at))) return {ok: false, why: 'the answer has no valid answered_at'};
  if (v.policy_environment !== 'production' && v.policy_environment !== 'staging') return {ok: false, why: 'the answer has no valid policy_environment'};
  if (v.authorization_id !== null && v.authorization_id !== undefined && !(typeof v.authorization_id === 'string' && UUID.test(v.authorization_id))) return {ok: false, why: 'the answer authorization_id is not a UUID'};
  if (v.reasons !== undefined && !Array.isArray(v.reasons)) return {ok: false, why: 'the answer reasons are malformed'};
  const reasons = ((v.reasons as unknown[]) ?? []).filter(isObj).map(r => ({...r, code: String(r.code ?? ''), message: String(r.message ?? '')}));
  for (const k of ['verdict', 'waiting_for', 'authorization_id', 'console_url', 'approve_url', 'wait_until', 'basis'] as const) if (!strOrNull(v[k])) return {ok: false, why: `the answer field ${k} is malformed`};
  if (v.failure !== null && v.failure !== undefined && !(isObj(v.failure) && typeof v.failure.code === 'string')) return {ok: false, why: 'the answer failure is malformed'};
  if (v.reasons_total !== undefined && !(Number.isInteger(v.reasons_total) && (v.reasons_total as number) >= 0)) return {ok: false, why: 'the answer reasons_total is malformed'};
  const poll = v.poll_after_seconds;
  if (poll !== null && poll !== undefined && (typeof poll !== 'number' || !Number.isFinite(poll))) return {ok: false, why: 'the answer poll interval is malformed'};
  const answer = {...v, reasons, basis: v.basis ?? null, verdict: v.verdict ?? null, waiting_for: v.waiting_for ?? null, failure: v.failure ?? null, authorization_id: v.authorization_id ?? null, console_url: v.console_url ?? null, approve_url: v.approve_url ?? null, wait_until: v.wait_until ?? null, poll_after_seconds: (poll as number | null) ?? null} as GateAnswer;
  if (answer.result === 'pass' && !verifiablePass(answer, !!expect.breakGlass)) return {ok: false, why: 'Zof sent a pass that has no stored ALLOW or audited basis'};
  return {ok: true, answer};
}

/** A pass needs its basis: a stored ALLOW with an executed authorization, a baseline, or a break-glass this client sent. */
function verifiablePass(a: GateAnswer, breakGlass: boolean): boolean {
  if (a.basis === 'decision') return a.verdict === 'allow' && typeof a.authorization_id === 'string' && a.authorization_id.length > 0;
  if (a.basis === 'baseline') return a.verdict === null;
  if (a.basis === 'break_glass') return breakGlass;
  return false;
}
