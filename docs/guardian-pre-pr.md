# Guardian Pre-PR Adversarial Gate — GUARDIAN-PREPR-001

This is a local host composition of Guardian, Mission and ApprovalStore. It does
not publish, invoke a model, create an approval, or execute a reviewer. A PASS is
an evidence verdict, never authorization to commit, push, merge or deploy.

## Existing capabilities reused

- `captureIntegrity` uses the existing `inside`/`sha256` helpers. It supplements
  preservation captures; it does not replace the Python metadata inspector.
- `gitReadRaw` shares the existing fixed executable, disabled fsmonitor, timeout
  and output limit with `gitRead`. The raw variant preserves exact diff bytes.
- `GuardianReview`, `GuardianFinding`, policy version and `verdictFor` retain the
  existing verdict semantics; there is no parallel review database or provider.
- `MissionContract`, `planHash`, `approvalContext` and `canPerform` bind scope,
  expected outputs, live human authorization, dependency evidence and revocation.
- Immutable `fixture/attempt/result-UUID` records use ApprovalStore's existing
  HMAC/name binding and private file checks. No new approval endpoint is added.

## Host workflow

1. Run the canonical read-only preflight and scope/roadmap inspection in a trusted
   local host, outside `recordPrePrCheck`. These observations do not execute a
   mission action or supply a verification receipt.
2. Supply `PrePrPolicy` directly from the human-authorized task. Register the
   exact repository URL, root, mission branch/base, assignment, author principal,
   independently authenticated reviewer IDs and required deterministic check IDs.
   The assignment's `expectedOutputs.files_to_touch` is an exact path allowlist;
   its full existing output contract supplies acceptance criteria.
3. `freezePrePrCandidate(policy)` performs two matching snapshots and writes a
   signed candidate. A read-only snapshot may be taken before approval; it grants
   no authority. It binds HEAD, base, branch, remote, host requirements, index,
   committed/staged/unstaged binary diffs, source hashes/modes/link targets, and
   review bytes for changed files. Unchanged files are hashed without retained Base64.
4. `prePrReviewPacket(policy, candidateRecord)` returns a data-only copy of the
   frozen diff, changed file bytes and acceptance criteria. It contains no store
   key, grants, callback or permission to alter code/requirements. It can be
   handed to an independently authorized reviewer outside this module. Prompt
   instructions embedded in source are data, not host authorization.
5. Wrap each deterministic verification action with
   `recordPrePrCheck(policy, candidateRecord, checkId, trustedHostCallback)`.
   The callback is supplied by host code, never by a worker/model. This is an
   observation wrapper, not a command runner. Before invoking the callback, it
   loads authenticated dependency evidence and calls the existing `canPerform`
   with `approvalContext`. Missing, revoked, expired or incomplete authority blocks
   without invoking the callback or recording an executed attempt. The existing
   store lock covers only authorization, attempt recording and synchronous callback
   invocation; it is released before awaiting the asynchronous check.
   It checks candidate identity before and after, records host times, selected
   authorization IDs, exit code, output digest and EvidenceContract. Completion
   requires the same grants still to be valid. Review rechecks those grants at the
   start/end times and live review time. Legacy receipts without this binding are
   invalid: late approval or a later successful check cannot authorize them.
   An exception/crash leaves an immutable unfinished attempt and blocks the gate.
6. A trusted identity adapter calls `recordPrePrReview` with its authenticated
   principal and `developer` or `independent` role. The submitted hypotheses carry
   a GuardianFinding, defect hypothesis, counterexample and reproduction steps.
   The verdict is recomputed; a supplied opinion of PASS is not accepted as a
   decision. A model cannot self-register an independent principal. This first
   implementation does not provide an identity adapter or invoke a reviewer.
7. `reviewPrePr` re-snapshots live content, authenticates **all** signed records
   for the candidate, checks required receipts, and re-runs `canPerform` with
   current approvals and authenticated mission evidence. Missing/unsafe evidence
   is BLOCKED. Missing independent review is explicitly `NOT_REVIEWED` and
   HUMAN_REVIEW unless another error already requires BLOCKED. No publication
   permission is returned, including when the technical verdict is PASS.

```ts
const candidate = freezePrePrCandidate(hostPolicy);
const packet = prePrReviewPacket(hostPolicy, candidate); // data-only; no execution
await recordPrePrCheck(hostPolicy, candidate, 'tests', runAuthorizedTests);
// If no authenticated independent reviewer is available, do not invent a receipt.
const decision = reviewPrePr(hostPolicy, candidate);
// decision.publicationAuthorized is always false.
```

The author ID and reviewer allowlist are trusted host policy, not authentication
by themselves. The same OS owner/root and ApprovalStore key remain trusted. A
malicious caller with those privileges can forge observations; HMAC does not prove
that an untrusted model became an independent reviewer. No real independent
review of this implementation is claimed by its synthetic positive-path tests.

## Integrity and invalidation

`lstat` classifies regular files, directories and symlinks before content access.
Regular files use O_NOFOLLOW and before/after identity checks. Directory entries
and internal links are recorded without reading directory content through links.
External/broken links, link ancestors, special files, read failures and size/path
limits report errors. Claude/OpenCode adapters remain links to `.agents/skills`.

Tracked files and nonignored untracked files are included. Ignored untracked
source is also included, except fixed generated/runtime roots: `node_modules`,
`dist`, `coverage`, `.next`, `.execution-qa`, `outputs`. Tracked files in these
roots are still included. Environment paths are checked before content capture or reading content diffs,
including deletions and both sides of renames in committed, staged and unstaged
layers. Git path lists are NUL-delimited, renames are expanded to delete/add and
content diffs use literal, already vetted pathspecs. Unsafe relative paths block.
Environment files block instead of exporting secrets; only the exact `.env.example`
name is treated as a public source template. Case variants and non-exact suffixes
block conservatively. This filename convention is not a secret scanner and no
selective secret redaction is used to turn a blocked candidate into an approval.
Submodules and conflicted indexes are unsupported and block before status can
inspect a nested worktree. External diff/textconv tools remain disabled for diffs;
these flags alone do **not** prevent clean/process filters.

Before snapshot inspection, and again before each status or diff invocation, the
host runs a metadata-only guard through the same bounded Git reader. It enumerates
effective configuration keys with `git config --includes --null --list --name-only`,
letting Git resolve local/worktree configuration and recursive/conditional includes.
Any `filter.<driver>.clean`, `.process` or `.smudge` declaration blocks with
`PREPR_GIT_FILTER_UNSAFE`, including unused or empty declarations. This conservative
MVP does not trust a driver or attempt to prove that an attribute selector is inactive.
It therefore covers drivers selected by root/nested `.gitattributes`,
`.git/info/attributes`, attribute macros or `core.attributesFile` without executing
their commands. Configuration read/parse errors, timeout or excessive output block;
configuration values are not included in the error or candidate.

The guard also reads `git ls-files --cached -v -z`, which examines index metadata
without applying content filters. Lowercase tags (`assume-unchanged`), S/s
(`skip-worktree`) and unknown/malformed tags block as `PREPR_INDEX_FLAGS_UNSAFE`
before trusting status, deriving changed paths or applying the scope allowlist.
Flags are never cleared automatically, even for unchanged or allowed files.
Adding filters or masking flags after freezing prevents packet/check/review reuse.
The reader still imposes `core.fsmonitor=false`, now also `core.hooksPath=/dev/null`,
a 3-second timeout and a 1 MiB output limit, with system/global Git configuration
excluded by the host. No repository/user configuration, attributes or index flags
are changed to obtain acceptance.

Changing a source byte, mode, link, index, branch, HEAD, scope, acceptance criterion,
required check or reviewer policy invalidates prior evidence. Re-staging unchanged
bytes also invalidates it: the index is part of the reviewed candidate. Test logs
are represented by a digest; the host must retain the actual logs separately.

Every source file is still read and hashed for identity, including unchanged large
files. Only changed-file bytes are retained in the authenticated candidate and
review packet; its full committed/staged/unstaged diffs remain exact. The packet
comes from the authenticated candidate after a fresh identity check, not from a
second unauthenticated content read. Changing an unchanged large file therefore
invalidates the prior candidate.

ApprovalStore's global 4 MiB serialized-record limit is unchanged. A candidate
that still cannot fit is rejected as `PREPR_CANDIDATE_TOO_LARGE`, with no record
written, truncation or missing review bytes. Git content-diff output over its
existing 1 MiB command limit is `PREPR_DIFF_TOO_LARGE`; the capture's existing
8 MiB per-file / 32 MiB aggregate byte limits report `PREPR_SOURCE_TOO_LARGE`.
The 5,000-path capture limit remains. These are separate bounds, not a promise
that every source below 32 MiB can fit its review data into a single record.
A roughly 3 MiB unchanged source with a tiny change elsewhere now fits because
its content is represented by a digest, not Base64. Large changed/untracked files
can still exceed the record limit and must remain blocked.

Before/after snapshots are not an OS sandbox or continuous write monitor. A
write-and-restore between observations can escape detection. Dependencies,
ignored generated/runtime roots, compiler/toolchain state and external services
are outside the source snapshot. The host must ensure exclusive control and add
separate deterministic checks for relevant external state. A content-bound test
receipt still only proves what that test checks; it does not prove semantic
correctness. Independent review and explicit human approval remain necessary.

## Adversarial benchmark

`src/guardian/fixtures/pre-pr-history.json` preserves small function fragments from
historical revisions, with source SHAs. The harness supplies their dependencies;
for the PR14 worker-review fragment, unrelated coding-evidence checks are stubbed
to isolate the missing identity/clock checks. The warning regex and omitted
approval-context evidence reproduce the original faulty expressions. These are
controlled function-level counterexamples, not historical end-to-end builds.
They never revert or modify merged source.

Run RED deliberately (expected nonzero; disposable fixtures only):

```sh
GUARDIAN_PREPR_BENCHMARK_LEGACY=1 npm test -- src/guardian/pre-pr-benchmark.test.ts
```

Run GREEN against current Guardian:

```sh
npm test -- src/guardian/pre-pr-benchmark.test.ts
```

| Case | Controlled defect / false result | Current deterministic coverage | Semantic work still required |
| --- | --- | --- | --- |
| Preservation | Reads a directory adapter as a file | `lstat` classification; explicit unsafe/read errors | New filesystem/storage constraints |
| PR14 source identity | Old build/HEAD certifies worker changes | Existing content/chronology gate + pre-PR candidate invalidation | Whether tests exercise changed behavior |
| PR14 clock | Separately sampled timestamps falsely disagree | One host review instant; invalid/backward clocks block | Time assumptions of new integrations |
| PR14 `/warning` | Route mistaken for diagnostic | Existing diagnostic-prefix classifier; route accepted | Unknown log grammar remains conservative |
| PR15 descendants | Parent close cancels escalation | Real owned-group timeout regression, no residual child | Deliberate process-group escape is not isolated |
| PR15 dependencies | Authenticated completion omitted from context | Existing collector accepts signed dependency evidence | Trustworthy host evidence production |
| PR15 fsmonitor | Repository code runs during Git inspection | Real benign-hook positive control; host hook blocked | New Git execution surfaces |

The pre-PR gate blocks a candidate whose required benchmark receipt fails; it does
not infer these bugs from text. With superficial green tests and only a developer
opinion, it remains NOT_REVIEWED. Unknown semantic defects are not automatically
detected by this benchmark, and no independent reviewer has been simulated for
this task. The fixture-only independent principals in unit tests test policy
mechanics, not actual adversarial review of this patch.

## Conservative behavior / false positives

- A failed or unfinished check and an error/human-review finding remain attached
  to the same candidate. A later success/clean review cannot hide them. This MVP
  has no waiver or finding-resolution mutation; a changed candidate requires new
  checks and review. Environmental failures may therefore block unchanged code.
- Changed staging, ignored source or mode bits invalidate even if runtime behavior
  is equivalent. Unknown formats, unsafe links, submodules and capture limits
  block instead of receiving optimistic PASS.
- Configured filters (including benign Git LFS drivers), empty/unused executable
  driver declarations and either masking index flag block conservatively. This MVP
  has no filter allowlist or automatic index repair. Hosts must retain exclusive
  control of configuration, attributes and index during inspection: the prechecks
  are not atomic OS isolation against concurrent write-and-restore attacks.
- A developer's blocking finding also blocks. A reviewer warning remains WARN,
  not PASS. Absent authenticated human verification approval blocks independently
  of successful checks or reviewer opinion.
