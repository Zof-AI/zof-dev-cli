/** Exit codes (spec section 8). Every non-zero fails the job. */
export const EXIT = {pass: 0, blocked: 1, config: 2, unavailable: 3, token: 4} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

interface Refusal {exit: ExitCode; text: string}

/** Error codes from spec section 3.6, with the next step for the reader of the job log. */
const REFUSALS: Record<string, Refusal> = {
  unauthorized: {exit: EXIT.token, text: 'Zof did not accept ZOF_GATE_TOKEN (unknown or revoked). Next: create a pipeline token in Zof Settings > Pipeline tokens and update the CI secret.'},
  token_expired: {exit: EXIT.token, text: 'ZOF_GATE_TOKEN has expired. Next: create a new pipeline token in Zof Settings > Pipeline tokens and update the CI secret.'},
  insufficient_scope: {exit: EXIT.token, text: 'ZOF_GATE_TOKEN is not a pipeline token. Next: use a token from Zof Settings > Pipeline tokens.'},
  gate_not_enabled: {exit: EXIT.token, text: 'The release gate is not turned on for your company in Zof. Next: ask your Zof admin or Zof support to turn it on.'},
  company_unbound: {exit: EXIT.token, text: 'The company that owns ZOF_GATE_TOKEN is no longer connected to this GitHub organisation. Next: reconnect it in Zof, or create a token in the right company.'},
  environment_not_allowed: {exit: EXIT.token, text: 'ZOF_GATE_TOKEN is not allowed for this environment. Next: pass the right --environment, or use a token that lists it.'},
  break_glass_not_allowed: {exit: EXIT.token, text: 'Zof refused the break-glass request. Next: check ZOF_BREAK_GLASS_TOKEN and the reason.'},
  repo_not_found: {exit: EXIT.config, text: 'Zof does not know this repository for your company. Next: check --repo (owner/name of the GitHub repository) and that Zof is installed on it.'},
  not_found: {exit: EXIT.config, text: 'Zof has no such gate check. Next: re-run the job.'},
  commit_ambiguous: {exit: EXIT.config, text: 'Two pull requests share this commit. Next: pass --pr with the pull request number.'},
  idempotency_conflict: {exit: EXIT.config, text: 'This run already asked Zof with different details. Next: re-run the job as a new attempt.'},
  payload_too_large: {exit: EXIT.config, text: 'The request to Zof was too large. Next: shorten --ref or --run-url.'},
  idempotency_key_required: {exit: EXIT.config, text: 'The request had no idempotency key. Next: report this to Zof support.'},
  invalid_body: {exit: EXIT.config, text: 'Zof refused the request details. Next: check the --repo, --commit, --ref, --pr, --run-id and --run-url values.'},
  unknown_environment: {exit: EXIT.config, text: 'Zof does not know which policy applies to this environment. Next: add or confirm it in Zof Settings > Environments, or pass the right --environment.'},
  commit_unknown: {exit: EXIT.blocked, text: 'Zof has no change for this commit. Deploy commits that came through a pull request Zof checked; if two pull requests share it, pass --pr.'},
};

/** Maps a refusal to an exit code; unknown codes fall back by status and never pass. */
export function refusal(status: number, code: string | undefined): Refusal & {code: string} {
  const known = code ? REFUSALS[code] : undefined;
  if (known) return {...known, code: code!};
  if (status === 401 || status === 403) return {exit: EXIT.token, code: code ?? `http_${status}`, text: 'Zof refused ZOF_GATE_TOKEN. Next: check the pipeline token in Zof Settings > Pipeline tokens.'};
  return {exit: EXIT.config, code: code ?? `http_${status}`, text: 'Zof refused the request. Next: check the zof gate options for this job.'};
}

export const SIDE = {
  [EXIT.blocked]: 'Blocked by Zof',
  [EXIT.config]: 'Problem in your pipeline configuration',
  [EXIT.unavailable]: "Zof unavailable (on Zof's side)",
  [EXIT.token]: 'Problem with the pipeline token in your pipeline',
} as const;
