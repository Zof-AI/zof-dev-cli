# Zof developer CLI

Run local static change checks, inspect dependencies, execute explicitly trusted test commands and produce portable verification evidence. Developers and CI maintainers can use every local command without an account. This is a clean-room release candidate for the separate `Zof-AI/zof-dev-cli` repository and candidate npm package `@zof-ai/cli`; it has not been published.

## Installation

Requires Node.js 22 or 24 and Git for revision analysis. After foundation dependencies are published, a clean source installation is:

```sh
npm ci --ignore-scripts
npm run build
npm test
node dist/cli.js help
```

During prerelease review, supply the reviewed dependency tarballs using the program staging tooling. Public registry installation is not yet verified. The installed executable is `zof`; source examples below use `node dist/cli.js`.

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

## Trusted test execution

Configure `testCommands` with `{name,argv,timeoutMs}` and a maximum timeout of 300000 ms. `argv[0]` is an executable, never a shell string. Tests run only on an explicit `test --allow-exec` invocation. This executes code with the caller's filesystem permissions; use only trusted commands. Untrusted AI candidates belong in the isolated evaluator. No command executes during static verification, init, policy or IDE/MCP analysis. Child output is discarded; only status and duration are recorded. Environment inheritance is limited to executable lookup and platform/temp variables. Do not put credentials in argv.

## Scope and limitations

Static rules identify dynamic evaluation, disabled TLS verification, enabled shell execution and selected credential patterns. They are review signals and can have false positives and false negatives. They do not prove code safe. Non-code text/assets are outside these checks; unsupported source is partial. Import analysis limitations are reported separately from static checks. Dirty working-tree evidence has no commit attribution because it is not the committed tree. Skipped/unconfigured tests never become passing test evidence.

No telemetry, repository upload or hosted requests occur. Public API documentation exists, but authentication, quotas and tenant isolation have not been accepted against an approved environment; hosted integration is unavailable. See [SECURITY.md](SECURITY.md), [API](docs/API.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [release process](docs/RELEASE.md). Built independently for [Zof](https://zof.ai); proposed Apache-2.0 licensing requires owner/legal approval.

## Additional public modules

`zof contract --baseline old.json --candidate new.json --format openapi` compares public API contracts. `zof schema --baseline old.sql --candidate new.sql` compares supported PostgreSQL snapshots. `zof risk` reports transparent advisory weights; `zof select-tests` reports conservative selection and full-suite fallbacks. They accept the same workspace/revision options where relevant. `zof suggest-tests --input generation.json` returns reviewable candidates without execution. `zof evidence --input junit.xml --format junit` (also json or static-json) normalizes existing reports through the secure CI normalizer. All modules work offline.
