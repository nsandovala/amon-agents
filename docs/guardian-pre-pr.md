# Guardian Pre-PR Adversarial Gate — GUARDIAN-PREPR-001

This is a local host composition of Guardian, Mission and ApprovalStore. It does
not publish, invoke a model, create an approval, or execute a reviewer. A PASS is
an evidence verdict, never authorization to commit, push, merge or deploy.

## Existing capabilities reused

- `captureIntegrity` uses the existing `inside`/`sha256` helpers. It supplements
  preservation captures; it does not replace the Python metadata inspector.
- `gitReadRaw` shares the existing fixed executable, disabled fsmonitor, timeout
  and output limit with `gitRead`. String output is decoded only after strict UTF-8
  validation; unsupported diff encodings block rather than lose bytes.
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

## Inspector trust boundary closure — PR16

Every inspection through the shared Git reader, including native batch object
reads, imposes `GIT_NO_LAZY_FETCH=1`, an empty `GIT_ALLOW_PROTOCOL`,
`GIT_TERMINAL_PROMPT=0` and `GIT_NO_REPLACE_OBJECTS=1`. The existing fixed executable,
disabled hooks/fsmonitor, filter precheck, timeout and output cap remain in force.
Effective configuration (including includes) declaring `extensions.partialClone`
or any remote's `promisor`/`partialCloneFilter` blocks as
`PREPR_PARTIAL_CLONE_UNSUPPORTED` **before object access**. Presence is enough,
including an unused remote or `promisor=false`; the MVP does not support partial
clones. A missing required local object fails closed, without transport, recovery,
or `upload-pack`. The lower-level reader also denies transport if its caller omits
the precheck. Neither configuration nor existing objects are repaired or rewritten.

`git ls-files --stage -z` supplies path, stage, mode and object ID. Only stage-zero
regular files and symlinks in SHA-1 repositories are supported; other formats,
submodules and malformed entries block explicitly. After unsafe/environment paths
are rejected, `captureIntegrity` computes the Git blob ID locally from each raw
file or link-target byte sequence, as well as the existing SHA-256 identity. No
clean filter, EOL conversion or encoding conversion participates in this hash.
Missing tracked paths count as deletions; directory replacements block. Regular
file modes are compared against index mode 0644/0755, including permission and
special bits, regardless of `core.filemode`. Symlink index mode 120000 represents
link type and target, not historical POSIX link permissions; the observed link
mode remains bound by the frozen snapshot. ACLs and extended attributes are not
part of this identity.

Physical differences are added to committed, staged, untracked, ignored-source
and Git-reported changes **before the allowlist**. Git cannot subtract a physical
change by normalization or configuration. Masking index flags still block even
if the file appears unchanged. Index/object presence is checked with native
`cat-file --batch-check`; raw preimages use `cat-file --batch` with validated object
IDs only and replacements disabled. This is a bounded local-object check, not a
full history/object-store fsck. Unrelated historical corruption is not certified.

The authenticated packet adds `rawWorktreeChanges`: indexed mode, object ID and
exact Base64 preimage for each physically changed tracked path. Its `files` entries
contain current exact bytes or link targets/modes; an absent entry denotes deletion.
Reviewers must examine these fields alongside the three Git diffs: a normalized
Git diff can be empty for a real physical change. These fields participate in the
same candidate hash, HMAC and fresh-snapshot comparison. Index preimages are read
only after path/environment/scope checks. Unchanged sources retain hashes, never
bulk Base64. ApprovalStore's 4 MiB contract is unchanged. Aggregate raw preimage
output over the reader's 1 MiB bound blocks as `PREPR_OBJECT_OUTPUT_TOO_LARGE`;
missing/non-blob/invalid batch evidence blocks as `PREPR_OBJECT_UNAVAILABLE`.
There is no truncation or partial successful packet.

### Consolidated regression matrix

The directed suite combines `pre-pr.test.ts`, `integrity.test.ts`,
`pre-pr-benchmark.test.ts` and `next-build-collector.test.ts`. Tests use disposable
repositories and fictitious markers/credentials; historical defective behavior
is exercised only in fixtures. Actual run counts and exit codes belong in the
handoff logs, not in this source contract.

| Threat / control | Deterministic observation or conservative block | Residual boundary |
| --- | --- | --- |
| Clean/process/smudge; included configuration and attribute sources | Executable declarations block before status/diff; legacy clean/process controls create a marker, guarded freeze does not | Unused/benign drivers also block; no trusted-filter allowlist |
| Fsmonitor / hooks | Host disables fsmonitor and hooks; benign fsmonitor control proves the hook would otherwise run | Trusted Git binary and OS execution environment required |
| Partial clone / missing blob / upload-pack | Real blob-less clone triggers the legacy canary; guarded freeze and direct reader never create it; missing unchanged index blob blocks without store/object writes | Declared partial/promisor repositories rejected; no full object-store audit |
| EOL, autocrlf, ident, encoding, filemode | Independent raw hash/mode reconciliation detects Git-hidden changes; allowed changes retain exact before/after evidence | Equivalent normalized bytes and noncanonical permissions may block conservatively |
| Assume-unchanged / skip-worktree; scope | Metadata-only flag guard blocks first; raw changes outside allowlist block; empty intent-to-add cannot disappear | Flags are never repaired; exclusive control of index required |
| Deleted/renamed .env, all three diff layers | Vetted path lists block before content export/store; exact .env.example remains allowed | Filename policy is not a general secret scanner |
| Symlinks, traversal, unsafe ancestors, deletion, read errors | lstat classification, local link-target hash and target scope; external/broken/ancestor links block; link-to-file changes detected | No traversal through directory links; POSIX ACL/xattr semantics outside identity |
| Staged/unstaged/untracked/ignored/binary source | Union of path lists and physical comparison; exact index preimage and raw current bytes; replacement objects disabled | Fixed generated/runtime exclusions remain; source and record limits still block |
| Altered records / code after freeze / large unchanged source | HMAC and fresh candidate identity reject tampering or later byte/mode/index changes, including raw preimages | HMAC trusts host key/owner; write-and-restore between observations is not excluded |
| Missing/expired/revoked grants; incomplete dependencies | Existing authorization contracts block check callback before execution and revalidate after it | Trusted host evidence provenance and clock are required |
| Missing independent review | `NOT_REVIEWED`; human review remains pending even with passing deterministic tests | Unit-test reviewer identities are fixtures, not a real independent review |
| Build chronology, clocks, warning routes, descendant timeout | Existing historical benchmark and owned-group collector regressions remain required | Semantic completeness of tests and deliberate process-group escape are not solved |

These finite counterexamples do **not** demonstrate universal absence of
vulnerabilities. The host, Git executable, store key and policy adapter are trusted.
Checks and two snapshots are not atomic OS isolation: a hostile concurrent process
can mutate and restore configuration, objects or files between observations.
Exclusive host control is a prerequisite; resource exhaustion, hostile process
escape and integrity of external dependencies/toolchains require separate controls.
No automatic publication, independent-review receipt or human approval is produced.

Git behavior references: [environment controls](https://git-scm.com/docs/git),
[native batch object reads](https://git-scm.com/docs/git-cat-file), and
[blob hashing versus filters](https://git-scm.com/docs/git-hash-object).

## Physical inventory and lossless encoding — PREPR-FINAL-INVENTORY-ENCODING

Before content capture, `inventorySource` in the existing integrity module streams
directory entries with `opendirSync` (one buffered entry), decodes names strictly,
and classifies each entry with `lstat`. It never opens source content or follows
symlinks. Root `.git` metadata is excluded; nested Git metadata, case aliases and
special/hardlinked entries block. The existing generated roots (`node_modules`,
`dist`, `coverage`, `.next`, `.execution-qa`, `outputs`) are pruned only when they
are actual root directories with no indexed descendants. A file/symlink with that
name and nested directories with those names are not exclusions. If indexed
source exists inside a generated root, enumeration takes precedence; additional
Git-hidden generated paths there can conservatively block as unaccounted.

The physical inventory is reconciled with index, untracked and ignored paths
before `captureIntegrity`. Any physical source path absent from the Git lists,
or a listed untracked/ignored path absent physically, blocks as
`PREPR_INVENTORY_UNACCOUNTED`; tracked absence still represents deletion. Physical
directories cannot substitute for indexed files. NFC/lowercase collisions between
physical, index and changed path components block as
`PREPR_INVENTORY_CASE_COLLISION`, including directory prefixes. This is conservative
ambiguity rejection, not an implementation of every filesystem's collation rules.
It blocks `code.ts`/`CODE.ts` even if both are allowed. Intentional case-only or
normalization-only renames may therefore require a different supported candidate.
No path, Git flag, configuration, line ending or permission is repaired automatically.

Each metadata walk allows at most 5,000 entries (including directories and pruned
roots), 32 path components, 4,096 UTF-8 bytes per relative path and 1 MiB of total
relative-path bytes. Name reconciliation independently bounds unique paths and
metadata bytes, with a bounded input list. A 3,000 ms monotonic deadline is checked
between filesystem operations and during reconciliation; limits report
`PREPR_INVENTORY_ENTRY_LIMIT`, `DEPTH_LIMIT`, `PATH_LIMIT` or `TIME_LIMIT` (all with
the `PREPR_INVENTORY_` prefix). Read failures and changed directory metadata block.
All opened directory handles close on success or error. The inventory is repeated
at the end of each snapshot; changed membership blocks before a packet is returned.
Empty directories are structural inventory, not source-file review bytes. The
existing two matching freeze snapshots and fresh reuse identity checks remain.

The deadline is cooperative: a synchronous syscall blocked by an unhealthy mount
cannot be interrupted by the JavaScript timer. Supported use requires a responsive
local filesystem and exclusive host control. No hard kernel resource containment,
continuous mutation monitor, hostile-process isolation or universal race safety is
claimed. Fixed source/record/Git output limits still apply independently.

All Git Buffer-to-string boundaries used by Pre-PR validate UTF-8 **before**
conversion. Textual diff output with invalid bytes blocks as
`PREPR_DIFF_ENCODING_UNSUPPORTED`, including staged and committed Latin-1 text
deletions. Raw path output blocks as `PREPR_PATH_ENCODING_UNSUPPORTED`; earlier
config/index guards can map that failure to their existing fail-closed codes.
Physical names and link targets also reject invalid encodings. No replacement
character is fabricated, BOM is preserved, and no textual preimage is invented.
Native batch headers are validated before parsing; object bodies stay Buffers and
retain their existing Base64 representation. Git's ASCII binary patches remain
supported: the regression reverses a staged binary deletion and verifies the
restored bytes exactly. Valid UTF-8 deletion diffs, including BOM and multibyte
characters, remain supported. Arbitrary non-UTF-8 text diffs are deliberately
unsupported even when some other packet field could retain their original bytes.

| Regression / guarantee | Evidence and behavior | Boundary |
| --- | --- | --- |
| Hidden case-distinct untracked source | Real case-sensitive fixture + core.ignoreCase=true: RED omitted CODE.ts and reused an identical packet after mutation; GREEN rejects freeze and reuse | Local QA uses explicitly authorized temporary APFS case-sensitive; Linux portability remains a later Ubuntu CI check |
| Physical path omitted from Git without collision | Injected Git-list omission blocks before file content capture/store writes | Failure injection tests reconciliation; not presented as another real Git exploit |
| Inventory limits and errors | Depth/entry/path caps, injected deadline/read error, directory mutation and handle closure regressions | Deadline/read injections are unit tests; no claim of OS cancellation |
| Generated, ignored and symlink paths | Ignored source retained and mutation invalidates; only authorized root directories pruned; links not followed by enumeration | Generated/runtime contents remain outside capture unless indexed |
| Latin-1 staged/committed deletion | RED produced caf� and lacked raw preimages; GREEN rejects before storing/exporting the candidate | Unsupported text encoding blocks conservatively |
| UTF-8 / binary positives | BOM/multibyte deletion bytes preserved; binary deletion patch restores byte-identical data | Filename validation is not a secret scanner |
| Prior trust-boundary matrix | Existing clean/process/fsmonitor, lazy-fetch, flags, CRLF/modes, .env/scope, authorization and invalidation tests remain required | CI/test success is not independent review or human authorization |

The case-sensitive test runs on Linux or when the trusted test host explicitly
sets `AMON_PREPR_CASE_FIXTURE_ROOT` to its disposable case-sensitive volume. It
asserts actual coexistence; it does not simulate Linux. Test setup/cleanup creates
only disposable fixtures there. A skipped platform-specific fixture must be
reported separately; it is not a PASS. Real independent review remains pending
where no authenticated reviewer receipt exists.
