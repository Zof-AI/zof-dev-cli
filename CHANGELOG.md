# Changelog

## 0.2.1

A clearer terminal for `zof review` and `zof copilot ask`.

- `zof review --wait` shows a live progress line while it waits: a spinner, the state, the lenses as they finish (when the console sends them) and the time so far, redrawn in place. The API is still asked every 5 seconds. Outside a terminal (CI, a pipe), with `NO_COLOR`, or with `--json` there is no animation: one plain line per change of state, on stderr with `--json`, so stdout stays one JSON document. The cursor is always restored, including on Ctrl-C and on errors.
- `zof copilot ask` shows the same spinner while Copilot thinks.
- `zof review --wait` and `zof review show` print a new result layout. It has a headline for the state, the PR and the number of files reviewed, and a summary wrapped to the terminal width and cut to five lines. Each finding has a severity badge, its location and a two-line description. A footer gives the review's short ID and its console link, printed once. No price is shown. `zof review show <id> --full` prints the whole summary and every description.
- Colour only in a terminal, never with `NO_COLOR`. Without colour the badges read `[HIGH]`. When the locale is not UTF-8 (`LC_ALL`, `LC_CTYPE` or `LANG`, so also when none is set), the output falls back to ASCII.
- Unchanged: `--json` output, exit codes (0 only for a done, complete review), and polling (5 s, `Retry-After`, timeouts). No new dependency.
- `zof agents run <key>` now starts a real run, which uses credits. It called a console route that does not exist, so it failed for everyone. It now starts the run on the console's start-run route.
- `zof agents run` requires `--repo OWNER/NAME`, `--commit SHA` (the full 40 characters) and `--capability KIND`. `--target-repo` is removed (use `--repo`), and so is the unused `--wait`. `--target-url` and `--config` (a JSON object) stay.
- Before starting, `zof agents run` asks `Continue? [y/N]` in a terminal, as `zof runs create` does. No route prices a single agent run, so no amount is shown. `--yes` skips the question. With no terminal to ask (CI, a pipe), it refuses without `--yes`: exit 2, and nothing is sent.
- When the console refuses an agent that needs a confirmed address, `zof agents run` says so and links to the agent in the console, instead of "Permission denied".

## 0.2.0

One `zof` for everything: the Zof console commands move here from the console repository's unpublished `@zof/cli` (apps/cli), so `npm i -g @zof-ai/cli` is the only CLI to install.

- Add the console commands: `zof auth` (login with the device code flow, logout, whoami, tokens), `zof config`, `zof agents`, `zof runs` (list, show, create, cancel, stream), `zof artifacts`, `zof approvals`, `zof copilot ask` and `zof copilot chat` (read-only from the CLI), `zof review <pr-url> [--wait] [--timeout] [--json]` and `zof review show`, `zof services` and `zof events stream`.
- One sign-in for everything that talks to the console. `zof auth login` (alias `zof login`) keeps it in the OS keychain (macOS Keychain, Windows Credential Manager, or a Secret Service keyring on Linux) through the pinned native binding `@napi-rs/keyring` 2.1.2, or `secret-tool` fed through stdin, so it never appears in a process's arguments. Only where no keychain exists does it fall back to `~/.zof/credentials.json` (mode 0600), and it says so. A keychain that refuses (for example, locked) saves nothing. `zof auth logout` (alias `zof logout`) revokes the sign-in in Zof and removes it from the keychain and the file.
- The planned test runs from the unreleased `zof run` work are folded in: `zof runs create --repo OWNER/NAME (--pr N | --commit SHA) --site/--api URL --category C` plans the tests, shows each gate and the price, asks, starts exactly the ticked tests and follows them. `zof runs cancel mrun_…` cancels one. `zof run …` stays as an alias of `zof runs create …`, and `zof run cancel` of `zof runs cancel`. These keep their own exit codes: 0 all passed, 1 issues or not all checked, 2 invalid or refused, 3 Zof unavailable, 4 not signed in. They use the same sign-in, requested with the `cli` scope.
- `zofcli_` tokens are redacted from gate output like the other Zof tokens.
- The console commands default to the production console, `https://console.zof.ai`; `ZOF_CONSOLE_URL` or `zof config set console_url` points them elsewhere. The URL must be https (http only for localhost), and a saved sign-in is only sent to the console that issued it.
- `ZOF_API_URL` stays the release gate's Control Plane URL and is never used by the console commands, so a pipeline can set both without one leaking into the other. Console commands use `ZOF_TOKEN` (a `zofcli_` token, for CI) in place of the saved sign-in; the gate still reads only `ZOF_GATE_TOKEN`.
- Console commands exit 0 on success, 1 on a failure or refusal, 2 on a usage error. `zof review --wait` and `zof review show` exit 0 only for a review that is done and complete; `zof copilot ask` exits 0 only with a real answer.
- The only new dependency is the keychain binding. The console commands use Node's built-in `fetch`, `readline` and `child_process`, and the sign-in page is opened with `open` or `xdg-open`, never through a shell.
- Every existing command, including `zof gate decide`, is unchanged. No command was renamed.

## 0.1.3

- Add `zof gate decide`, which asks Zof whether a commit may deploy and waits up to 10 minutes by default for the answer.
- Exit codes tell a pipeline what happened: 0 pass, 1 blocked, 2 configuration problem, 3 Zof unavailable, 4 token problem. Any outage fails closed and never reports a pass.
- Zof tokens are redacted from output, and GitHub Actions and GitLab CI are detected automatically, with `--json` printing a single JSON line for errors.
- The first release published through npm trusted publishing.

## 0.1.2

Document public installation, executable entry points and reproducible packaged examples. Align release dependency pins; runtime behavior is unchanged.

## 0.1.1

- Update affected dependencies to the hardened diff parser and refresh reviewed release artifacts.

## 0.1.0

Initial independently authored public implementation, distributed under Apache-2.0.
