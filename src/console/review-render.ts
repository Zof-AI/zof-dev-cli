export interface ReviewFinding {
  severity: string
  title: string
  source_location?: {path: string; line?: number} | null
  location?: {type?: string; path?: string; line?: number | null; name?: string} | null
}

export interface ReviewDetail {
  review: {
    review_id: string
    status: string
    complete?: boolean | null
    summary?: string | null
    counts_by_severity?: Record<string, number>
    failure_reason?: string | null
    repo?: string
    pr?: number | null
  }
  findings: ReviewFinding[]
  actor_names?: Record<string, string>
}

// Review text is model output about untrusted code: drop control characters (ESC included) so it cannot steer the
// terminal; tabs and line breaks become spaces.
const clean = (s: string): string => s.replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const rank = (s: string): number => {
  const i = SEVERITIES.indexOf(s)
  return i === -1 ? SEVERITIES.length : i
}

function place(f: ReviewFinding): string | null {
  if (f.source_location?.path) return `${f.source_location.path}${f.source_location.line ? `:${f.source_location.line}` : ''}`
  const loc = f.location
  if (!loc) return null
  if (loc.path) return `${loc.path}${loc.type === 'file' && loc.line ? `:${loc.line}` : ''}`
  return loc.name ?? null
}

function counts(c: Record<string, number> | undefined): string {
  const known = SEVERITIES.filter((s) => (c?.[s] ?? 0) > 0).map((s) => `${s} ${c?.[s]}`)
  const other = Object.entries(c ?? {})
    .filter(([s, n]) => !SEVERITIES.includes(s) && n > 0)
    .map(([s, n]) => `${s} ${n}`)
  const all = [...known, ...other]
  return all.length > 0 ? all.join(' · ') : 'none'
}

/** A review as plain lines (the command colours nothing inside them): header, counts, sorted findings, console link. */
export function renderReview(detail: ReviewDetail, dashboardUrl: string): string[] {
  const r = detail.review
  const lines = [
    `ID: ${r.review_id}`,
    ...(r.repo ? [`PR: ${r.repo}${r.pr ? `#${r.pr}` : ''}`] : []),
    `Status: ${r.status}`,
    `Complete: ${r.complete === true ? 'yes' : r.complete === false ? 'no' : 'unknown'}`,
    ...(r.failure_reason ? [`Failure: ${r.failure_reason}`] : []),
    ...(r.summary ? [`Summary: ${r.summary}`] : []),
    `Findings: ${counts(r.counts_by_severity)}`,
  ]
  const sorted = detail.findings
    .map((f, i) => ({f, i}))
    .sort((a, b) => rank(a.f.severity) - rank(b.f.severity) || a.i - b.i)
  for (const {f} of sorted) {
    const where = place(f)
    lines.push(`[${f.severity}] ${f.title}${where ? ` — ${where}` : ''}`)
  }

  lines.push(`Open in console: ${dashboardUrl}`)
  return lines.map(clean)
}

/**
 * JSON for --json. JSON.stringify already escapes U+0000-U+001F; this also escapes U+007F-U+009F (C1 controls, e.g.
 * U+009B, a one-byte CSI) so model text cannot reach the terminal raw. The result parses to the same data.
 */
export function reviewJson(data: unknown): string {
  return JSON.stringify(data, null, 2).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** For a wait that never got an answer from the console. */
export function renderNoAnswer(reviewId: string, dashboardUrl: string): string[] {
  return [
    `No answer from the console before the timeout for review ${reviewId}.`,
    `See it later: zof review show ${reviewId}`,
    `Open in console: ${dashboardUrl}`,
  ]
}
