/** gate.v1 shapes from the CI/CD release gate spec, sections 3.1 and 3.3. */
export const PROVIDERS = ['github_actions', 'gitlab_ci', 'bitbucket', 'azure_pipelines', 'jenkins', 'circleci', 'other'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface GateRequest {
  schema_version: 1;
  repo: string;
  commit_sha: string;
  ref?: string;
  pull_request?: number;
  environment: string;
  pipeline: {provider: Provider; run_id: string; run_attempt: number; job: string; run_url?: string};
}

export interface GateReason {code: string; message: string; requirement_key?: string | null; remedy?: string | null}

export interface GateAnswer {
  schema_version: 1;
  kind: 'gate_check';
  gate_id: string;
  repo: string;
  commit_sha: string;
  environment: string;
  policy_environment?: string | null;
  state: 'waiting' | 'final';
  result: 'waiting' | 'pass' | 'fail';
  basis: 'decision' | 'baseline' | 'break_glass' | null;
  verdict: string | null;
  waiting_for: string | null;
  reasons: GateReason[];
  reasons_total?: number;
  failure: {code: string; message: string} | null;
  authorization_id: string | null;
  console_url: string | null;
  approve_url: string | null;
  wait_until: string | null;
  poll_after_seconds: number | null;
  [key: string]: unknown;
}
