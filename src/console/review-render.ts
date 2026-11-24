import {elapsed, fit, glyphs, paint, visible, wrap, type Out, type Style} from './output.js'

export interface ReviewFinding {
  severity: string
  title: string
  description?: string | null
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
    created_at?: string | null
    finished_at?: string | null
    coverage?: {reviewed?: string[]; incomplete?: string[]} | null
    lenses?: Array<{profile: string; status: string}> | null
  }
  findings: ReviewFinding[]
  actor_names?: Record<string, string>
}

// Review text is model output about untrusted code: drop control characters (ESC included) so it cannot steer the
// terminal; tabs and line breaks become spaces.
const clean = (s: string): string => s.replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
const str = (v: unknown): string => (v == null ? '' : clean(String(v)))

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const rank = (s: string): number => {
  const i = SEVERITIES.indexOf(s)
  return i === -1 ? SEVERITIES.length : i
}
// Maps, not objects: a server severity such as `constructor` or `__proto__` must not find an inherited member.
const BADGE = new Map<string, Style>([['critical', 'redBg'], ['high', 'red'], ['medium', 'yellow'], ['low', 'blue']])
const COUNT = new Map<string, Style>([['critical', 'red'], ['high', 'red'], ['medium', 'yellow'], ['low', 'blue'], ['info', 'dim']])
// Unknown severities show at most 8 characters, in the badge and in the heading.
const short = (s: string): string => (SEVERITIES.includes(s) ? s : fit(s, 8, ''))
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - [...s].length))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function place(f: ReviewFinding): string | null {
  if (f.source_location?.path) return `${f.source_location.path}${f.source_location.line ? `:${f.source_location.line}` : ''}`
  const loc = f.location
  if (!loc) return null
  if (loc.path) return `${loc.path}${loc.type === 'file' && loc.line ? `:${loc.line}` : ''}`
  return loc.name ?? null
}

/** The time a review took (or has run so far), when it is known. */
function took(r: ReviewDetail['review'], running: boolean, opts: {waitedMs?: number; now?: number}): number | undefined {
  const created = Date.parse(r.created_at ?? '')
  const finished = Date.parse(r.finished_at ?? '')
  if (Number.isFinite(created) && Number.isFinite(finished)) return finished - created
  if (opts.waitedMs !== undefined) return opts.waitedMs
  if (running && opts.now !== undefined && Number.isFinite(created)) return opts.now - created
  return undefined
}

/**
 * A review as complete terminal lines (indented, coloured through `o`): headline, meta, summary, findings, then a footer
 * with the short id and the console URL. The footer line is never cut, so the URL stays clickable. A file location is
 * never cut either, so it stays copyable. No price is ever shown.
 */
export function renderReview(detail: ReviewDetail, url: string, o: Out, opts: {full?: boolean; waitedMs?: number; now?: number} = {}): string[] {
  const r = detail.review
  const g = glyphs(o)
  const W = o.width ?? 80
  const findings = detail.findings ?? []
  const terminal = r.status === 'done' || r.status === 'failed'
  const t = took(r, !terminal, opts)
  const tail = ` ${g.dot} ${plural(findings.length, 'finding')}${terminal && t !== undefined ? ` ${g.dot} ${elapsed(t)}` : ''}`
  // W - 45, or less when the rest of the headline would push it past the width (`  ! Review incomplete ()` is 24).
  const why = (reason: string): string => (reason ? ` (${fit(reason, Math.min(W - 45, W - 24 - visible(tail)), g.more)})` : '')

  let head: string
  if (r.status === 'done' && r.complete === true) head = `${paint(o, 'green', g.ok)} ${paint(o, 'bold', 'Review complete')}`
  else if (r.status === 'done') {
    const incomplete = Array.isArray(r.coverage?.incomplete) ? r.coverage.incomplete.map(str).join('; ') : ''
    head = `${paint(o, 'yellow', g.warn)} ${paint(o, 'bold', `Review incomplete${why(incomplete || str(r.failure_reason))}`)}`
  } else if (r.status === 'failed') head = `${paint(o, 'red', g.fail)} ${paint(o, 'bold', `Review failed${why(str(r.failure_reason))}`)}`
  else head = `${paint(o, 'yellow', g.warn)} ${paint(o, 'bold', t === undefined ? 'Still running' : `Still running after ${elapsed(t)}`)}`
  const lines = [`  ${head}${tail}`]

  const meta = [
    r.repo ? `${str(r.repo)}${r.pr ? `#${str(r.pr)}` : ''}` : '',
    Array.isArray(r.coverage?.reviewed) ? `${plural(r.coverage.reviewed.length, 'file')} reviewed` : '',
  ].filter(Boolean).join(` ${g.dot} `)
  if (meta) lines.push(`    ${paint(o, 'dim', fit(meta, W - 4, g.more))}`)
  lines.push('')

  const summary = wrap(str(r.summary), Math.max(20, W - 4))
  if (summary.length > 0) {
    const cut = !opts.full && summary.length > 5
    lines.push(`  ${paint(o, 'bold', 'Summary')}`, ...(cut ? summary.slice(0, 4) : summary).map(l => `    ${l}`))
    if (cut) lines.push(`    ${paint(o, 'dim', `${g.more} full summary in the console`)}`)
    lines.push('')
  }

  const shown = findings
    .map((f, i) => ({f, i, sev: str(f.severity)}))
    .sort((a, b) => rank(a.sev) - rank(b.sev) || a.i - b.i)
  if (shown.length === 0) lines.push('  No findings', '')
  else {
    const counts = new Map<string, number>()
    for (const {sev} of shown) counts.set(sev, (counts.get(sev) ?? 0) + 1)
    // Counts that do not fit the width are dropped for a trailing `…` (the list below still shows every finding).
    const all = [...counts].map(([sev, n]) => ({sev, text: `${n} ${short(sev)}`}))
    const room = (k: number, cut: boolean) => 13 + all.slice(0, k).reduce((w, p, i) => w + (i ? 2 : 0) + [...p.text].length, 0) + (cut ? 2 + [...g.more].length : 0)
    let k = all.length
    while (k > 0 && room(k, k < all.length) > W) k--
    const parts = all.slice(0, k).map(({sev, text}) => (COUNT.has(sev) ? paint(o, COUNT.get(sev)!, text) : text))
    if (k < all.length) parts.push(g.more)
    lines.push(`  ${paint(o, 'bold', 'Findings')}   ${parts.join('  ')}`, '')

    const label = (sev: string) => short(sev).toUpperCase()
    const L = Math.max(...shown.map(({sev}) => [...label(sev)].length))
    const C = 2 + L + 2 + 2
    const indent = ' '.repeat(C)
    const width = Math.max(20, W - C)
    for (const {f, sev} of shown) {
      const badge = o.color ? paint(o, BADGE.get(sev) ?? 'dim', pad(` ${label(sev)} `, L + 2)) : pad(`[${label(sev)}]`, L + 2)
      const [first = '', ...rest] = wrap(str(f.title), width)
      lines.push(`  ${badge}  ${first}`, ...rest.map(l => indent + l))
      const where = place(f)
      if (where) lines.push(indent + paint(o, 'dim', str(where)))
      const text = wrap(str(f.description), width)
      if (!opts.full && text.length > 2) text.splice(1, Infinity, fit(`${text[1]} ${g.more}`, width, g.more))
      lines.push(...text.map(l => indent + l), '')
    }
  }

  const id = str(r.review_id)
  const shortId = [...id].length > 12 ? [...id].slice(0, 12).join('') + g.more : id
  lines.push(`  ${paint(o, 'dim', g.rule.repeat(Math.min(60, W - 4)))}`, `  ${paint(o, 'dim', `${shortId}  ${g.dot}  ${url}`)}`)
  return lines
}

/** The waiting text: `live` for the spinner line (lens marks, cut to `maxWidth`), else a plain progress line. */
export function progressText(detail: ReviewDetail | null, ms: number, o: Out, live: boolean, maxWidth?: number): string {
  const g = glyphs(o)
  const label = !detail || detail.review.status === 'queued' ? 'Queued' : 'Reviewing'
  const lenses = detail?.review.lenses?.length ? detail.review.lenses : null
  if (!live) {
    const done = lenses ? lenses.filter(l => l.status === 'done').length : 0
    return `${label}${lenses ? ` ${g.dot} ${done} of ${lenses.length} lenses done` : ''} ${g.dot} ${elapsed(ms)}`
  }
  const mark = (s: string) => (s === 'done' ? g.ok : s === 'failed' || s === 'incomplete' ? g.warn : g.more)
  const text = `${label}${lenses ? `  ${lenses.map(l => `${str(l.profile)} ${mark(l.status)}`).join('  ')}` : ''}   ${elapsed(ms)}`
  return maxWidth === undefined ? text : fit(text, maxWidth, g.more)
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
