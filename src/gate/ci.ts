import type {Provider} from './types.js';

export type Env = Readonly<Record<string, string | undefined>>;
export type ReadFile = (path: string) => Promise<string>;

/** What the CI tells us about this run; flags override every field. */
export interface CiFacts {
  provider: Provider;
  label: string;
  repo?: string;
  commit?: string;
  ref?: string;
  pullRequest?: number;
  runId?: string;
  runAttempt?: number;
  job?: string;
  runUrl?: string;
  environment?: string;
}

const int = (v: string | undefined) => (v && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : undefined);
const val = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Detects GitHub Actions and GitLab CI (spec section 8). Other providers come in G-2. */
export async function detectCi(env: Env, readFile: ReadFile): Promise<CiFacts> {
  if (env.GITHUB_ACTIONS === 'true') {
    const repo = val(env.GITHUB_REPOSITORY);
    let commit = val(env.GITHUB_SHA);
    let pullRequest: number | undefined;
    // On pull_request events GITHUB_SHA is the merge ref; the change is keyed by the PR head.
    if (env.GITHUB_EVENT_PATH) {
      try {
        const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH)) as {pull_request?: {number?: unknown; head?: {sha?: unknown}}};
        const pr = event.pull_request;
        if (pr && typeof pr.head?.sha === 'string') commit = pr.head.sha;
        if (pr && typeof pr.number === 'number' && Number.isInteger(pr.number) && pr.number > 0) pullRequest = pr.number;
      } catch { /* no event file: fall back to GITHUB_SHA */ }
    }
    const runId = val(env.GITHUB_RUN_ID);
    const server = val(env.GITHUB_SERVER_URL);
    return {provider: 'github_actions', label: 'GitHub Actions', repo, commit, ref: val(env.GITHUB_REF), pullRequest, runId, runAttempt: int(env.GITHUB_RUN_ATTEMPT), job: val(env.GITHUB_JOB),
      runUrl: server && repo && runId ? `${server.replace(/\/+$/, '')}/${repo}/actions/runs/${runId}` : undefined};
  }
  if (env.GITLAB_CI === 'true') {
    // The repo is the GitHub one, so CI_PROJECT_PATH is not used. CI_MERGE_REQUEST_IID is a GitLab number, not a GitHub PR, so it is not sent.
    return {provider: 'gitlab_ci', label: 'GitLab CI', commit: val(env.CI_COMMIT_SHA), ref: val(env.CI_COMMIT_REF_NAME), runId: val(env.CI_PIPELINE_ID), runAttempt: int(env.CI_JOB_ID),
      job: val(env.CI_JOB_NAME), runUrl: val(env.CI_JOB_URL), environment: val(env.CI_ENVIRONMENT_NAME)};
  }
  return {provider: 'other', label: 'CI'};
}
