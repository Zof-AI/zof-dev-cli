# Zof developer CLI

Run local static change checks, inspect dependencies, execute explicitly trusted test commands and produce portable verification evidence. Developers and CI maintainers can use every local command without an account. The source repository is `Zof-AI/zof-dev-cli`; the package identifier is `@zof-ai/cli`. npm and GitHub source installation are documented below.

<!-- ZOF_NPM_INSTALL_START -->
## Install from npm

Use Node.js 22 or 24 and npm. File-based operations require Linux or macOS with Python 3.10 or newer; Windows file operations fail closed. In a new project directory, install the version used by this guide:

```sh
npm install --ignore-scripts --save-exact @zof-ai/cli@0.2.0
npx --no-install zof --help
```

The package includes compiled JavaScript, TypeScript declarations and its runtime dependencies. No source build, Zof account or repository upload is required. `--ignore-scripts` disables installation lifecycle scripts; `--no-install` keeps the example commands from downloading another package.

Confirm the public ESM entry point; this prints `function`:

```sh
node --input-type=module -e "import('@zof-ai/cli').then(api => console.log(typeof api.verify))"
```

Run a packaged example from the same directory:

```sh
npx --no-install zof verify --root node_modules/@zof-ai/cli/examples/clean --changed math.ts --json
```

The clean synthetic file produces passing static-check evidence. It does not claim that unit tests ran.

Package: [@zof-ai/cli](https://www.npmjs.com/package/@zof-ai/cli). The source-checkout instructions and three additional workflows follow.
<!-- ZOF_NPM_INSTALL_END -->

<!-- ZOF_RELEASE_INSTALL_START -->
## Install from GitHub source

Requires Node.js 22 or 24, npm, and Git. Filesystem operations require Linux or macOS with Python 3.10 or newer; Windows file operations fail closed. Clone this repository and explicitly prepare its reviewed release dependencies:

```sh
git clone --branch v0.2.0 --depth 1 https://github.com/Zof-AI/zof-dev-cli.git
cd zof-dev-cli
node scripts/bootstrap.mjs --allow-network
npm ci --ignore-scripts --prefer-offline
npm run build
npm test
```

The bootstrap downloads only the exact versioned dependency assets from [GitHub Releases](https://github.com/Zof-AI/zof-dev-cli/releases), as listed in `scripts/release-dependencies.json`, verifies SHA256 and byte size, and adds them to the npm cache. It does not extract archives, run package scripts, collect application data, or send credentials. Downloads require the explicit flag and follow only HTTPS GitHub asset redirects. Installation then fetches ordinary third-party dependencies from npm. Use a writable npm cache; set `npm_config_cache` consistently for both commands if needed. An unavailable asset, changed hash, or oversized response stops installation.

<!-- ZOF_RELEASE_INSTALL_END -->

## Installation

Requires Node.js 22 or 24 and Git for revision analysis. After the GitHub source installation above, validate the checkout:

```sh
npm ci --ignore-scripts
npm run build
npm test
node dist/cli.js help
```

The installed executable is `zof`. The source-checkout examples below use the equivalent `node dist/cli.js` entry point.

## Three practical workflows

```sh
# 1. Scan a known synthetic file without a Git repository.
node dist/cli.js verify --root examples/clean --changed math.ts --json
# 2. Detect a deliberately unsafe synthetic change (exit 1).
node dist/cli.js verify --root examples/unsafe --changed dynamic.ts
# 3. Initialize a synthetic project and examine missing test execution (exit 2).
node dist/cli.js init --root examples/project
node dist/cli.js test --root examples/project --allow-exec
```

Initialization exclusively creates `zof.config.json`; it will not overwrite one. Remove only that generated file from the example project before repeating example 3. Static verification prints `completed/pass` for the clean example and `completed/fail` with `dynamic-evaluation` for the unsafe example. It never claims that unit tests ran.

## Commands

| command | behavior |
|---|---|
| init | creates version 1 local configuration |
| verify | scans changed source lines for documented generic static risks |
| diff | summarizes added/removed lines and paths, without source snippets |
| impact | analyzes conventional static TS/JS/Python imports and consumers |
| test | runs configured argv commands only with `--allow-exec` |
| evidence | emits local verification evidence, or validates/redacts `--input FILE` |
| policy | evaluates `--policy FILE --evidence FILE`, optionally `--now ISO` |
| doctor | reports Node/Git availability and supported capabilities |
| version | prints package version |
| help | prints options and exit codes |

`--json` selects structured reports. `--root DIR` sets the workspace. `--base REF [--head REF]` compares revisions; the checkout must match an explicitly supplied head. Repeated `--changed PATH` supplies explicit relative files. `--fail-on` selects info/low/medium/high/critical (default high). Exit 0 is a successful completed check, 1 is a configured failure and 2 is invalid, missing or incomplete execution. Standard errors are concise; JSON reports contain detailed structured findings without source excerpts.

## Zof console commands

The same `zof` also drives the Zof console: sign in once, then review pull requests, ask Copilot and follow runs from the terminal.

```sh
zof auth login                                   # (or zof login) device code flow; opens the console sign-in page
zof review https://github.com/acme/web/pull/42 --wait
zof review show rev_01JD0000000000000000000000 --json
zof copilot ask "Why did the last run fail?"
zof runs list --status running
zof run --repo acme/app --pr 12 --site https://staging.acme.example --site-env staging --category security
zof services status
zof auth logout                                  # (or zof logout)
```

| topic | commands |
|---|---|
| auth | `login [--console-url URL] [--no-browser]`, `logout`, `whoami`, `tokens` (`zof login` / `zof logout` are aliases) |
| config | `list`, `get <key>`, `set <key> <value>`, `use-org <id>`, `use-env <id>` (keys: `console_url`, `org_id`, `env_id`, `output_format`, `color`) |
| review | `<pr-url> [--wait [--timeout SECONDS]]` (default 900, at most 3600), `show <review-id>` |
| copilot | `ask "<question>"`, `chat` (read-only from the CLI: answers and look-ups, never changes) |
| agents | `list [--category] [--family] [--class]`, `show <key>`, `health <key>`, `run <key> --repo OWNER/NAME --commit SHA --capability KIND [--target-url URL] [--config JSON]` (starts a run; uses credits) |
| runs | `list [--status] [--limit] [--page]`, `show <id>`, `create --name NAME [--trigger]`, `create --repo OWNER/NAME (--pr N \| --commit SHA) --site/--api URL --category C [--yes]` (planned test run; `zof run` is an alias), `cancel <id>`, `stream <id>` |
| artifacts | `list --run-id ID`, `show <id> --run-id ID`, `download <id> --run-id ID [-o FILE]` |
| approvals | `list [--status]`, `show <id>`, `approve <id> [--reason]`, `reject <id> [--reason]` |
| services | `status`, `ping` |
| events | `stream [--topics a,b]` |

Every console command takes `--json` and `--help`. Exit 0 is success, 1 a failure or refusal (including not signed in), 2 a usage error. `zof review --wait` and `zof review show` exit 0 only for a review that finished and is complete, so CI can gate on them. **One sign-in.** `zof auth login` keeps the sign-in in your OS keychain (macOS Keychain, Windows Credential Manager, or a Secret Service keyring on Linux) through a pinned native binding. On Linux without the binding it uses `secret-tool`, which reads the secret from stdin, so the sign-in never appears in a process's arguments. Only where no keychain exists does it fall back to `~/.zof/credentials.json` (mode 0600), and it tells you so. A saved sign-in is sent only to the console that issued it. CI sets `ZOF_TOKEN` instead. `zof auth logout` revokes it in Zof and removes it from the keychain and the file.

**Planned test runs.** `zof runs create --repo …` (or `zof run …`) plans the tests, prints each with its gate and the price, asks `Run N tests for <price>? [y/N]`, then starts exactly the ticked tests with the plan's fingerprint and only the origins you pass with `--authorize`, and follows the run.
- `--yes` skips the question only when stdin is not a terminal.
- Ctrl-C stops following and never cancels; use `zof runs cancel mrun_…` to cancel.
- `--pr` without `--commit` reads the pull request's head from this checkout's `origin`, and only if `origin` is that repository on github.com.
- These runs never change whether a pull request can ship.
- Exit codes: 0 all passed, 1 issues found or not all checked, 2 invalid input or a refusal, 3 Zof unavailable, 4 not signed in.

## Environment variables

The local tools need none. The release gate and the console commands each read their own, so one pipeline can set both.

| variable | used by | meaning |
|---|---|---|
| `ZOF_GATE_TOKEN` | `zof gate` | pipeline token (`zgt_`); required, never a flag |
| `ZOF_API_URL` | `zof gate` | the Control Plane URL from Settings > Pipeline tokens. Console commands never read it. |
| `ZOF_CONSOLE_URL` | console commands | console origin; default `https://console.zof.ai`. https only (http for localhost). Overrides `console_url` in `~/.zof/config.json`. |
| `ZOF_TOKEN` | console commands and test runs | CLI token (`zofcli_`) for CI; overrides the `zof auth login` sign-in |
| `ZOF_ORG_ID`, `ZOF_ENV_ID` | console commands | active organization and environment; override `zof config use-org` / `use-env` |
| `ZOF_OUTPUT` | console commands | `table` (default) or `json` in `zof config list` |
| `ZOF_NO_COLOR=1`, `NO_COLOR` | console commands | no colour (colour is used only on a terminal anyway) |

## Trusted test execution

Configure `testCommands` with `{name,argv,timeoutMs}` and a maximum timeout of 300000 ms. `argv[0]` is an executable, never a shell string. Tests run only on an explicit `test --allow-exec` invocation. This executes code with the caller's filesystem permissions; use only trusted commands. Untrusted AI candidates belong in the isolated evaluator. No command executes during static verification, init, policy or IDE/MCP analysis. Child output is discarded; only status and duration are recorded. Environment inheritance is limited to executable lookup and platform/temp variables. Do not put credentials in argv.

## Scope and limitations

Static rules identify dynamic evaluation, disabled TLS verification, enabled shell execution and selected credential patterns. They are review signals and can have false positives and false negatives. They do not prove code safe. Non-code text/assets are outside these checks; unsupported source is partial. Import analysis limitations are reported separately from static checks. Dirty working-tree evidence has no commit attribution because it is not the committed tree. Skipped/unconfigured tests never become passing test evidence.

The local commands make no telemetry, repository upload or hosted request. Only `zof gate` and the console commands talk to Zof, and only when you run them. See [SECURITY.md](SECURITY.md), [API](docs/API.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [release process](docs/RELEASE.md). Built independently for [Zof](https://zof.ai); Licensed under [Apache-2.0](LICENSE).

## Additional public modules

`zof contract --baseline old.json --candidate new.json --format openapi` compares public API contracts. `zof schema --baseline old.sql --candidate new.sql` compares supported PostgreSQL snapshots. `zof risk` reports transparent advisory weights; `zof select-tests` reports conservative selection and full-suite fallbacks. They accept the same workspace/revision options where relevant. `zof suggest-tests --input generation.json` returns reviewable candidates without execution. `zof evidence --input junit.xml --format junit` (also json or static-json) normalizes existing reports through the secure CI normalizer. All modules work offline.

## Filesystem and Git boundaries

Filesystem operations use bounded, directory-relative descriptors on Linux/macOS with Python 3.10 or newer. Symlinks, hard-linked inputs, special files and traversal are rejected. Open descriptors remain attached to the original directory when names change. File contents can still change during a read or snapshot; this is not an atomic filesystem snapshot. Windows filesystem operations fail closed; in-memory JSON validation and analysis do not require the file helper. Git reads use a private bounded snapshot: 256 MiB total, 32 MiB per source/object file, 50,000 entries and 64 directory levels. Repository hooks/configuration are not used; local `.git/info/exclude` and `.git/info/attributes` are preserved. External Git metadata, object alternates, grafts, sparse-checkout metadata, linked worktrees and submodules are unsupported. Limits and unsupported metadata cause an explicit error or incomplete result.

Explicit trusted test commands run on Linux/macOS only. Windows command execution is refused. Commands run with the caller's permissions and are not a sandbox; timeout/cancellation terminates their process group.
