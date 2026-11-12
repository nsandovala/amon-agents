---
name: amon-runtime-qa
description: Verify actual local runtime acceptance after a fix; use when HTTP, browser, authentication, data or authorization behavior is required and builds or unit tests are insufficient.
metadata:
  version: "1.0.0"
---

# amon-runtime-qa


1. Read `.agents/standards/policy.md`, especially ES-06–10, and run amon-preflight.
2. Turn the approved acceptance criteria into required checks before execution.
   Requirements cannot be relaxed by the report. Record run ID, worktree, branch and SHA.
3. Observe the configured port's owner, issue HTTP from the local host with a timeout,
   and capture status/error. A 3xx redirect or sign-in page is not authenticated success.
4. Use a real browser and the real application. Check session establishment, protected
   view access, the specified QA snapshot and required permissions/revocation behavior.
   Automated real-browser checks are valid when they actually run against the application;
   unit mocks and canned responses are not. Record artifacts without tokens or personal data.
5. If DB or auth blocks progress, record the exact missing QA prerequisite. Do not alter
   controls or production. Retain a failing result and use an authorized local context
   when sandbox restrictions prevent the observation.
6. Evaluate `releaseGate` in `src/standards/gates.ts` with human-derived requirements
   and observations matching `release-gate.schema.json`. Guardian PASS is only worker
   evidence; it does not replace runtime checks. Return NO-GO if any required check is
   missing or not real/passed. Explain layers not run and remaining risks.
