# Changelog

## Unreleased

- Add `zof gate --environment NAME` using the shared `@zof-ai/gate` client; retain `zof gate decide` as an alias.
- Use the shared provider detection, strict gate-answer validation, redaction, break-glass handling and exits 0–4.
- Depend on the published `@zof-ai/gate@1.0.2` command API (`runGateCli`).

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
