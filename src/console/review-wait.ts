import {ApiError} from './api.js'
import type {ReviewDetail} from './review-render.js'

export const POLL_INTERVAL_MS = 5000

export interface WaitOptions {
  timeoutMs: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export const isTerminal = (status: string): boolean => status === 'done' || status === 'failed'

// A console that is down, slow or busy for a moment (5xx, no connection, a request timeout, 429) is worth asking again;
// any other error (a 4xx) is an answer and stops the wait.
// (Status 0 is also used for an unreadable answer, UNKNOWN_ERROR: that is not worth asking again.)
const transient = (e: unknown): boolean =>
  e instanceof ApiError && (e.errorCode === 'NETWORK_ERROR' || e.statusCode === 408 || e.statusCode === 429 || e.statusCode >= 500)

/**
 * Asks for the review every interval until it is done or failed, or the time runs out. Each fetch is told how
 * long is left, so its own request can be capped at that. On timeout it returns the last answer it got, or null.
 */
export async function waitForReview(
  fetchDetail: (remainingMs: number) => Promise<ReviewDetail>,
  opts: WaitOptions,
): Promise<{detail: ReviewDetail | null; timedOut: boolean}> {
  const {timeoutMs, intervalMs = POLL_INTERVAL_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms))} = opts
  const deadline = now() + timeoutMs
  let last: ReviewDetail | null = null
  for (;;) {
    let pause = intervalMs
    try {
      last = await fetchDetail(deadline - now())
      if (isTerminal(last.review.status)) return {detail: last, timedOut: false}
    } catch (error) {
      if (!transient(error)) throw error
      // A server that says when to come back is waited for at least that long (the deadline still caps it).
      const after = (error as ApiError).retryAfterS
      if (after !== undefined) pause = Math.max(pause, after * 1000)
    }

    const left = deadline - now()
    if (left <= 0) return {detail: last, timedOut: true}
    await sleep(Math.min(pause, left))
    if (deadline - now() <= 0) return {detail: last, timedOut: true}
  }
}

/** 0 only for a review that finished and reviewed everything it meant to; anything else (fail closed) is 1. */
export function reviewExitCode(detail: ReviewDetail | null, timedOut: boolean): 0 | 1 {
  return !timedOut && detail?.review.status === 'done' && detail.review.complete === true ? 0 : 1
}
