# Release process

Version 0.1.0 is prepared under [Apache-2.0](../LICENSE). [GitHub Releases](https://github.com/Zof-AI/zof-dev-cli/releases) is the initial distribution channel. Refer to the release's actual assets and commit SHA; these instructions are not evidence that an upload or installation succeeded.

Start with the [source installation](../README.md#install-from-github-source). Run `node scripts/bootstrap.mjs --allow-network`, `npm ci --ignore-scripts --prefer-offline`, `npm run build`, `npm test`, and `npm pack --ignore-scripts`. The bootstrap checks the exact dependency release SHA256 and byte sizes. Do not replace failed checks with an unverified dependency or a `file:` reference in published metadata.

Before releasing a new version, inspect source and Git history, dependency licenses, build outputs and every package entry. Resolve security findings; run independent negative and installation tests. Record artifact SHA256 and release commits. Maintain branch protection, private vulnerability reporting, least-privilege workflows and a protected release environment. The manual release-candidate workflow builds artifacts and does not publish automatically. Material release changes require a new review.

Publish the reviewed package tarball as a GitHub Release asset. npm registry publication requires independently verified `@zofai` scope ownership and an authenticated publisher. Registry publication and registry install acceptance are not claimed by a GitHub release.

After publication, retrieve assets anonymously, verify their checksums, install in a clean project, and execute documented examples. Check every intended distribution channel separately. Missing or unrun acceptance is not a pass. Hosted Zof integration remains unavailable until an approved public contract and real service acceptance exist.

CI targets Node 22/24 on Linux/macOS. File operations require Python 3.10 or newer and fail closed on Windows; in-memory JSON operations remain portable. Only completed jobs establish platform verification. Docker acceptance runs on Linux; editor acceptance exercises a real VS Code host.
