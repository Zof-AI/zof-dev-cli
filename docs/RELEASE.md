# Release process

Version 0.1.2 is distributed under [Apache-2.0](../LICENSE). [GitHub Releases](https://github.com/Zof-AI/zof-dev-cli/releases) provides versioned source and reviewed build artifacts. Install `@zof-ai/cli@0.1.2` using the [npm quickstart](../README.md#install-from-npm). Refer to the release assets, commit SHA and recorded validation for the exact version.

Start with the [source installation](../README.md#install-from-github-source). Run `node scripts/bootstrap.mjs --allow-network`, `npm ci --ignore-scripts --prefer-offline`, `npm run build`, `npm test`, and `npm pack --ignore-scripts`. The bootstrap checks the exact dependency release SHA256 and byte sizes. Do not replace failed checks with an unverified dependency or a `file:` reference in published metadata.

Before releasing a new version, inspect source and Git history, dependency licenses, build outputs and every package entry. Resolve security findings; run independent negative and installation tests. Record artifact SHA256 and release commits. Maintain branch protection, private vulnerability reporting, least-privilege workflows and a protected release environment. The manual [release workflow](../.github/workflows/release.yml) builds a candidate by default and publishes only when a maintainer asks it to and a `release` environment reviewer approves. Material release changes require a new review.

Publish the reviewed package tarball as a GitHub Release asset. Verify the registry version and integrity, then run the README commands in a fresh project before recording registry acceptance.

## npm trusted publishing

The workflow publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions presents a short-lived OIDC identity and npm exchanges it for a single-use publish token. No npm token is stored in the repository, its secrets or the `release` environment. Every published version carries a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) that links it to this repository, the workflow and the commit.

### One-time setup

1. **Link the trusted publisher.** `@zof-ai/cli` already exists on npm (0.1.2, published from the `zof-ai` organization), so no manual first publish is needed. A member of the `zof-ai` npm organization with publish rights opens `@zof-ai/cli` on npmjs.com > **Settings** > **Trusted publishing**, chooses **GitHub Actions** and enters: organization or user `Zof-AI`, repository `zof-dev-cli`, workflow filename `release.yml`, environment `release`, and saves.
2. **Lock token publishing.** In the same settings, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working; long-lived tokens can no longer publish.
3. **Release environment.** In the GitHub repository settings, keep the `release` environment with required reviewers and deployment limited to protected branches. Add no npm secret to it.

### Cutting a release

1. On a branch, set the new version, which must be above the latest version on npm (0.1.2 today), in `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version`), move the `Unreleased` changelog entries under the new version and update the version shown in the README and this document. Merge the pull request into `main` after review.
2. Run **Actions** > **Release** on `main` with the version and `publish` left off. Inspect the candidate: the job summary records the tarball SHA256 and the `npm-tarball` artifact holds the exact package.
3. Run **Release** again on `main` with the same version and `publish` on. The `candidate` job checks that the version matches `package.json` and is above the latest npm version, runs `npm run check` and packs the tarball; the `publish` job waits for a `release` reviewer, verifies the tarball's SHA256 and publishes that file with `npm publish --access public --provenance`. Nothing is rebuilt between the check and the publish.
4. Tag the released commit `v<version>`, create the GitHub Release with the tarball and its SHA256, then complete the post-publication checks below.

After publication, retrieve assets anonymously, verify their checksums, install in a clean project, and execute documented examples. Check every intended distribution channel separately. Missing or unrun acceptance is not a pass. Hosted Zof integration remains unavailable until an approved public contract and real service acceptance exist.

CI targets Node 22/24 on Linux/macOS. File operations require Python 3.10 or newer and fail closed on Windows; in-memory JSON operations remain portable. Only completed jobs establish platform verification. Docker acceptance runs on Linux; editor acceptance exercises a real VS Code host.
