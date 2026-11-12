---
name: amon-handoff
description: Prepare a reviewable engineering handoff after local work; use to report evidence, full diffs, limitations and GO/NO-GO without publishing.
metadata:
  version: "1.0.0"
---

# amon-handoff


1. Read `.agents/standards/policy.md` (ES-01, ES-06–10).
2. Reuse `core/output-contract.yaml` and `validateOutput`: goal, scope, files_to_touch,
   plan, risks, validations, done_when. Do not create another output/evidence contract.
3. Include actual directory, branch, base/current SHA, existing changes preserved,
   modified and untracked files, full diff, exact commands/results and artifact references.
   Include imported skill source/version and any adaptation. Redact secrets from artifacts.
4. Separate simulation/unit results from real HTTP/browser/auth observations and official
   emulator coverage. Report NO-GO when a required layer was not run, even if tests pass.
5. Reuse WorkerJobState/CodingToolEvidence, Mission EvidenceContract and GuardianReview
   for their existing purposes. Add preflight/release observations only for missing concepts.
6. State risks and GO/NO-GO for human review. GO is a recommendation, never permission
   to commit, push, open a PR, merge or deploy. Stop at the task's requested boundary.
