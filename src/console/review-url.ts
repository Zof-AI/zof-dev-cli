export const PR_URL_HELP = 'Expected https://github.com/<owner>/<repo>/pull/<number>'

export type ParsedPrUrl = {ok: true; repo: string; pr: number} | {ok: false; message: string}

// The path of a PR page: /<owner>/<repo>/pull/<n>, optionally its /files or /commits tab, optionally a trailing slash.
const PR_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,8})(?:\/(?:files|commits))?\/?$/

/** Reads a github.com pull request URL; anything else (another host, an issue, a query or fragment) is refused. */
export function parsePrUrl(input: string): ParsedPrUrl {
  const refuse = {ok: false, message: `Not a GitHub pull request URL: ${input || '(empty)'}. ${PR_URL_HELP}`} as const
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return refuse
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    return refuse
  }

  // `new URL` keeps a literal '?' or '#' with nothing after it out of search/hash; refuse those from the raw input too.
  if (/[?#]/.test(input)) return refuse
  const m = PR_PATH.exec(url.pathname)
  if (!m) return refuse
  return {ok: true, repo: `${m[1]}/${m[2]}`, pr: Number(m[3])}
}
