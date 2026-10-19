# Public API 0.1.0

`verify({root,base?,head?,changedFiles?,exclude?,failOn?,signal?})` returns `{evidence,impact,exitCode}`. Evidence is validated against Evidence 1.0.0; impact uses impact/v1. Aborted requests and invalid/unbounded inputs throw safe errors. `formatVerification(result)` formats a plain report.

`init(root)` creates configuration exclusively; `loadConfig(root)` validates all version 1 fields and bounds. `runTests(root,{allowExecution,signal?})` records one observation per configured command. It runs explicitly trusted commands on Linux/macOS and terminates their process group on timeout or cancellation. Windows execution is refused. Commands retain the caller's permissions and are not sandboxed.

`readEvidence(root,path)` validates/redacts existing local evidence. `doctor()` reports capabilities and Git availability. `analyzeImpact` and `evaluatePolicy` are re-exported public foundations. `VERSION` and `CAPABILITIES` support consumers. The library has no automatic network or telemetry behavior.

The maximum scanned source size is 2 MiB per file; impact traversal supplies aggregate file/diff limits. Finding output is limited to 1000 entries. Git external diff/textconv are disabled by the impact analyzer. The CLI never reads `.env` for configuration, never returns raw source, and never includes raw process output or arbitrary environment values in evidence. Artifact handling is delegated to the strict evidence contract.
