import {ApiError} from '../api.js';
import {UsageError} from '../args.js';
import {required, type Command} from '../context.js';
import {info, keyValue, success, warn} from '../output.js';
import {renderNoAnswer, renderReview, reviewJson, type ReviewDetail} from '../review-render.js';
import {reviewUrl, startReview, type StartedReview} from '../review-start.js';
import {parsePrUrl} from '../review-url.js';
import {reviewExitCode, waitForReview} from '../review-wait.js';

export const DEFAULT_TIMEOUT_S = 900;
export const MAX_TIMEOUT_S = 3600;
const REVIEW_ID = /^rev_[0-9A-Za-z]{26}$/;

const REFS_HINTS = new Map<string, string>(Object.entries({
  pr_not_found: 'only open pull requests in a repository connected to your org can be reviewed',
  lookup_incomplete: "the PR was not in the first pages of your org's open changes; try again later or review it from the console",
}));

export const start: Command = {
  usage: `zof review <pr-url> [--wait [--timeout SECONDS]] [--json]`,
  summary: `Run a Zof code review of a GitHub pull request; --wait polls until it finishes (default ${DEFAULT_TIMEOUT_S}s, at most ${MAX_TIMEOUT_S}s) and exits 0 only for a done, complete review`,
  args: ['pr-url'],
  flags: {wait: {kind: 'bool'}, timeout: {kind: 'int', min: 1, max: MAX_TIMEOUT_S}},
  async run(ctx, p) {
    const target = parsePrUrl(required(p, 0, 'pull request URL'));
    if (!target.ok) throw new UsageError(target.message);
    if (p.flags.timeout !== undefined && !p.flags.wait) throw new UsageError('--timeout only applies with --wait.');
    const client = await ctx.authed();
    const {o, json} = ctx;
    let started: StartedReview;
    try {
      started = await startReview({get: path => client.get(path), post: (path, body, headers) => client.post(path, body, {headers})}, target, ctx.deps.uuid());
    } catch (error) {
      const hint = error instanceof ApiError ? REFS_HINTS.get(error.errorCode) : undefined;
      if (error instanceof ApiError && hint) throw new ApiError(error.statusCode, error.errorCode, `${error.errorCode} - ${hint}`, error.requestId);
      throw error;
    }

    const url = reviewUrl(client.baseUrl, started.review_id);
    const timeoutS = (p.flags.timeout as number | undefined) ?? DEFAULT_TIMEOUT_S;
    if (!p.flags.wait) {
      if (json) { o.out(reviewJson({review_id: started.review_id, run_id: started.run_id, url})); return 0; }
      success(o, `Review started: ${started.review_id}`);
      keyValue(o, [['ID', started.review_id], ['Run', started.run_id], ['PR', `${target.repo}#${target.pr}`]]);
      o.out('');
      info(o, `Open in console: ${url}`);
      info(o, `See the result: zof review show ${started.review_id}`);
      return 0;
    }

    if (!json) {
      success(o, `Review started: ${started.review_id}`);
      info(o, `Open in console: ${url}`);
      info(o, `Waiting for the review (up to ${timeoutS}s)...`);
    }

    const path = `/api/reviews/${encodeURIComponent(started.review_id)}`;
    const waitStart = ctx.deps.now();
    const {detail, timedOut} = await waitForReview(
      remainingMs => client.get<ReviewDetail>(path, {timeout: Math.max(1, Math.min(30_000, remainingMs))}),
      {timeoutMs: timeoutS * 1000, now: ctx.deps.now, sleep: ctx.deps.sleep},
    );
    if (json) {
      o.out(reviewJson(detail ? {...detail, timed_out: timedOut} : {review_id: started.review_id, url, timed_out: true}));
    } else {
      o.out('');
      if (detail) for (const line of renderReview(detail, url, o, {waitedMs: ctx.deps.now() - waitStart})) o.out(line);
      else for (const line of renderNoAnswer(started.review_id, url)) o.out(`  ${line}`);
      if (timedOut) warn(o, `Timed out after ${timeoutS}s; the review is still running. See it later: zof review show ${started.review_id}`);
    }

    return reviewExitCode(detail, timedOut);
  },
};

export const show: Command = {
  usage: 'zof review show <review-id> [--json]',
  summary: 'Show a Zof code review and its findings (exits 1 unless it is done and complete)',
  args: ['review-id'],
  async run(ctx, p) {
    const id = required(p, 0, 'review ID');
    if (!REVIEW_ID.test(id)) throw new UsageError(`Not a review ID: ${id.slice(0, 40)}. Expected rev_ followed by 26 letters or digits.`);
    const client = await ctx.authed();
    const detail = await client.get<ReviewDetail>(`/api/reviews/${id}`);
    if (ctx.json) ctx.o.out(reviewJson(detail));
    else for (const line of renderReview(detail, reviewUrl(client.baseUrl, id), ctx.o, {now: ctx.deps.now()})) ctx.o.out(line);
    // A queued or running review is not done: 1.
    return reviewExitCode(detail, false);
  },
};
