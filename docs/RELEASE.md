# Release and maintenance

Run a clean locked install, build, tests and `npm pack --ignore-scripts`. Inspect every tarball entry, scan content and history, review dependency licenses and record SHA-256 checksums. Obtain owner approval for namespace, IP review, legal approval and security review. Configure verified maintainer ownership, private vulnerability reporting, protected main and protected release environment. The candidate workflow cannot publish. Enable npm trusted publishing and provenance only after those external gates and explicit authorization. Never publish a `file:` dependency or unverified runtime bundle.

After an authorized release, verify anonymous installation and execute documented examples from the published artifact. Supported runtimes are Node 22 and 24; CI covers Linux, macOS and Windows, but only actual completed jobs constitute platform verification.
