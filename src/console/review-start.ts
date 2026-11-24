/** The two console calls a review start needs; the command passes apiGet/apiPost, tests pass fakes. */
export interface ReviewApi {
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body: unknown, headers: Record<string, string>) => Promise<T>
}

export interface StartedReview {
  review_id: string
  run_id: string
  change_id: string
}

interface RefResponse {
  ref?: {kind?: string; change_id?: string}
}

/**
 * Starts a review exactly as the console's "Review now" does: pin the PR to its change (GET /api/run/refs), then
 * POST /api/reviews {change_id} once, with the caller's Idempotency-Key. Errors pass through; nothing is retried.
 */
export async function startReview(api: ReviewApi, target: {repo: string; pr: number}, idempotencyKey: string): Promise<StartedReview> {
  const query = new URLSearchParams({repo: target.repo, ref: String(target.pr)})
  const {ref} = await api.get<RefResponse>(`/api/run/refs?${query}`)
  if (ref?.kind !== 'pr' || typeof ref.change_id !== 'string' || !ref.change_id) {
    throw new Error(`${target.repo}#${target.pr} did not resolve to a pull request in Zof.`)
  }

  const started = await api.post<{review_id: string; run_id: string}>(
    '/api/reviews',
    {change_id: ref.change_id},
    {'Idempotency-Key': idempotencyKey},
  )
  return {review_id: started.review_id, run_id: started.run_id, change_id: ref.change_id}
}

/** The console page of a review. */
export function reviewUrl(apiUrl: string, reviewId: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/code-review/${encodeURIComponent(reviewId)}`
}
