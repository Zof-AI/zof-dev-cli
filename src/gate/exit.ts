/** Exit codes (spec section 8). Every non-zero fails the job. */
export const EXIT = {pass: 0, blocked: 1, config: 2, unavailable: 3, token: 4} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** What happened and what to do next: plain words, no internal names or codes. */
interface Refusal {exit: ExitCode; what: string; next: string}

const NEW_TOKEN = 'Create a pipeline token in Zof (Settings > Pipeline tokens) and update the CI secret.';

/** The gate's error codes, each with a log line for the person whose deploy failed. */
const REFUSALS: Record<string, Refusal> = {
  unauthorized: {exit: EXIT.token, what: "Zof didn't accept ZOF_GATE_TOKEN.", next: NEW_TOKEN},
  token_expired: {exit: EXIT.token, what: 'ZOF_GATE_TOKEN has expired.', next: NEW_TOKEN},
  insufficient_scope: {exit: EXIT.token, what: "ZOF_GATE_TOKEN isn't a pipeline token.", next: NEW_TOKEN},
  gate_not_enabled: {exit: EXIT.token, what: 'The release gate is off for your company.', next: 'Ask Zof support to turn it on.'},
  company_unbound: {exit: EXIT.token, what: "This token's company is no longer connected to this GitHub organisation.", next: 'Reconnect it in Zof, or use a token from the right company.'},
  environment_not_allowed: {exit: EXIT.token, what: "ZOF_GATE_TOKEN can't deploy to this environment.", next: 'Check --environment, or use a token that allows it.'},
  break_glass_not_allowed: {exit: EXIT.token, what: 'Zof refused the break-glass request.', next: 'Check ZOF_BREAK_GLASS_TOKEN and the reason.'},
  repo_not_found: {exit: EXIT.config, what: "Zof doesn't know this repository.", next: 'Check --repo (owner/name) and that Zof is installed on it.'},
  not_found: {exit: EXIT.config, what: "Zof can't find this check.", next: 'Re-run the job.'},
  commit_ambiguous: {exit: EXIT.config, what: 'Two pull requests share this commit.', next: 'Pass --pr with the pull request number.'},
  idempotency_conflict: {exit: EXIT.config, what: 'This job run already asked Zof with different details.', next: 'Re-run the job.'},
  payload_too_large: {exit: EXIT.config, what: 'The request is too large.', next: 'Shorten --ref or --run-url.'},
  idempotency_key_required: {exit: EXIT.config, what: "Zof couldn't match this request to the job run.", next: 'Contact Zof support.'},
  invalid_body: {exit: EXIT.config, what: "Zof couldn't read the job details.", next: 'Check --repo, --commit, --ref, --pr, --run-id and --run-url.'},
  unknown_environment: {exit: EXIT.config, what: "Zof doesn't know the rules for this environment.", next: 'Add or confirm it in Zof (Settings > Environments), or check --environment.'},
  commit_unknown: {exit: EXIT.blocked, what: 'Zof has no pull request for this commit.', next: 'Deploy a commit from a pull request Zof checked. If two pull requests share it, pass --pr.'},
};

/** Maps a refusal to an exit code; unknown codes fall back by status and never pass. */
export function refusal(status: number, code: string | undefined): Refusal & {code: string} {
  const known = code ? REFUSALS[code] : undefined;
  if (known) return {...known, code: code!};
  if (status === 401 || status === 403) return {exit: EXIT.token, code: code ?? `http_${status}`, what: 'Zof refused ZOF_GATE_TOKEN.', next: NEW_TOKEN};
  return {exit: EXIT.config, code: code ?? `http_${status}`, what: 'Zof refused the request.', next: 'Check the zof gate options for this job.'};
}

export const SIDE = {
  [EXIT.blocked]: 'Blocked by Zof',
  [EXIT.config]: 'Problem in your pipeline configuration',
  [EXIT.unavailable]: "Zof unavailable (on Zof's side)",
  [EXIT.token]: 'Problem with your pipeline token',
} as const;
