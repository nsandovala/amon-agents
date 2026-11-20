# Guardian Next.js release evidence — host collection

`src/guardian/next-build.ts` adds a deterministic, read-only evidence check to the
existing Guardian and `releaseGate`. It starts no build, agent, server or network
request, changes no authorization, and supplies no acceptance override.

## Integration and authority

`releaseGate` now detects existing local npm Next projects from `package.json`
and `package-lock.json`. Omitting every Next/host field blocks with
`NEXT_HOST_CONTEXT_REQUIRED`; ambiguous manifests/locks block as well. A declared
host release (`policy.releaseHost`) always requires a live, registered source root
and current mission authorization. Detection of Next makes `nextBuild` mandatory;
there is no worker opt-out. Non-Next observation contracts remain compatible.

The legacy pure-observation API still supports offline historical reports whose
roots do not exist locally. It is not an authenticated release host or deployment
permission. Production host integrations must always declare `releaseHost`; the
worker cannot select the host entry point, requirements file or registered root.

The runtime observation has one optional `nextBuild` object. Neither it nor worker
output may supply acceptance criteria, warning exceptions or advisory exclusions.
An observation containing Next evidence without host requirements blocks. An
explicit but invalid host `nextBuild` also blocks. Required HTTP, browser, auth,
business and emulator checks remain independent and unchanged.

The existing read-only entry point exposes the full result and a nonzero exit on
failure:

```sh
node dist/standards/cli.js release observations.json trusted-requirements.json
```

For worker reviews, the host may additionally pass
`GuardianReviewDeps.nextBuild = { evidence, policy }` to `runGuardianReview`, or
the same option to `reviewWorkerJobEvidence`. The existing finding/verdict logic
combines both checks, binds the Next policy to the worker's worktree/revision and
review time, and cannot convert a worker failure into PASS. This optional context
is not loaded from the worker JSON. No new orchestrator or CLI command is added.

HEAD identifies committed contents, not a coding tool's uncommitted output. The
combined review requires an explicitly clean `gitStatusAfter`, an empty
`changedFiles` list and matching worker/build HEADs. Missing or contradictory
content evidence blocks; the existing contract has no content digest with which
to attest dirty output. The build must also start at or after the worker's valid
finish time, so an earlier build cannot attest later work. These checks do not
relax the existing worker policy: a coding job with no changes still returns
`HUMAN_REVIEW` (`CHANGED_FILES_EMPTY`), and worker HEAD changes still block.
The standalone release gate continues to accept valid clean revision evidence
subject to all its other requirements.

`runGuardianReview` captures one host review timestamp after reading the worker
record. `reviewWorkerJobEvidence` uses its host-supplied `reviewedAt` for the Next
policy's `now`, on a copy of the requirements. It does not require equality with
a separately sampled policy clock or accept a clock from worker JSON. Build and
advisory freshness checks remain active. Standalone `releaseGate` callers still
supply their own trusted host time as before.

Requirements files remain a trusted-host boundary, as in ES-07. These validators
cannot prevent someone with write access to that host's configuration from
changing it. Keep approved requirements outside model-generated artifacts and
review changes through the existing human approval / mission authorization flow.
No change to `MissionContract`, grants, `planHash` or `canPerform` is required.

## Build and environment observations

The existing release schema now describes the Next observation. The host must
collect the actual `next build` child process (not a shell pipeline's final exit
or a coding agent's exit), its full stdout/stderr, termination, timeout/signal,
start/end timestamps, run/root/branch/SHA before and after, clean tree state,
Node version/platform, installation and effective build `NODE_ENV`, exact
lockfile SHA-256, and the fresh final `BUILD_ID` artifact and reference.

Zero exit alone is insufficient: complete execution/logs, matching revision and
environment, successful final result and artifact created during the build are
all required. Dirty source, partial logs, stale artifacts, failed prerendering
and contradictory failure diagnostics block. `Compiled successfully` supplies
no acceptance condition. Installation `NODE_ENV` must equal the host's approved
value (null means unset); effective build `NODE_ENV` must be `production`.
`development`/`test` are standard values but unsuitable for this build check.
Nonstandard values such as `staging` block in either phase. This checks effective
observations; it does not inspect shell profiles or `.env` files.

Warnings beginning with diagnostic markers/prefixes (`⚠`, `warn`, `warning`,
`[warn]`/`[warning]`, or Node's `(node:PID) ... Warning:` format) are retained in
the source logs. Leading whitespace and ANSI colors are handled. Ordinary route
summaries containing `/warning` or `/warn` are not diagnostics; a genuine warning
about either route still blocks. Tracing,
`outputFileTracingRoot`, inferred workspace root and multiple-lockfile warnings
receive `NEXT_TRACING_WARNING`; all other warnings receive
`NEXT_WARNING_UNCLASSIFIED`. Both block. The exact documented Next CI notice
`No build cache found` with its full canonical message and documentation URL is
retained as informational `NEXT_BUILD_CACHE_COLD`; it describes build performance,
not an incomplete build (https://nextjs.org/docs/messages/no-cache). Additional
text or another diagnostic remains blocking. There is no agent
allowlist or suppression. Findings point to combined stdout/stderr line numbers
instead of echoing potentially sensitive raw text. The host collector captures both streams and classifies diagnostics before
redacting credentials. Legacy callers remain responsible for their own logs. Future diagnostic formats
without recognizable markers require an explicit parser update and tests.

## Version and security evidence

Resolve `packages["node_modules/next"].version` from the host-read **npm lockfile
v2/v3**, never the manifest range, log banner or a model's recommended version.
The same bytes' SHA-256 must match the build observation. Missing, linked,
multiple/nested installations, unsupported lockfiles and prereleases fail closed.
Yarn, pnpm, npm v1, workspace selection and prerelease range support are deferred.

The host supplies a nonempty approved advisory scope, a freshness cutoff, and
each GitHub global advisory's ID, API source URL, retrieval timestamp, response
body and expected SHA-256. Obtain and pin those bytes from the public source
outside model evidence; the hash checks consistency, not authenticity of the
network acquisition. ID/source/content/time/withdrawal checks must pass. The
parser supports stable numeric comparisons (`<`, `<=`, `>`, `>=`, `=`), comma or
space conjunctions and `||`; unsupported syntax is not interpreted optimistically.

Each required advisory returns one of:

- `affected`: the resolved package version matches a verified affected range;
  blocks. This confirms a version match, not exploitability of a deployment.
- `insufficient_information`: missing, stale, malformed, unsupported, duplicate
  or unverifiable data; blocks.
- `not_affected`: outside the supplied advisory's affected ranges. This is only
  a scoped result, never a claim that Next.js has no other vulnerabilities.

No advisory catalog or historical range is hardcoded into production logic.
An empty scope cannot establish safety. The host is responsible for obtaining
the current complete advisory scope appropriate to its release and for evaluating
feature/deployment applicability. This increment performs no online scan.

## Reproducible references and limits

`next-advisory.json` is a structured excerpt of
<https://api.github.com/advisories/GHSA-7m27-7ghc-44w9>, retrieved on 2026-11-18
UTC. Its published ranges are `>= 13.0.0, < 13.5.8`,
`>= 14.0.0, < 14.2.21`, `>= 15.0.0, < 15.1.2`. Tests exercise their boundaries.
This historical test snapshot is not a current security scan. The vendor page
and global API have different range presentation; this fixture uses the explicit
structured global API entries without inferring missing intervals.

Convergence's apparent compilation / later build failure and Sentinel's missing
runtime evidence serve as synthetic regression references only. Their repositories
are neither modified nor accepted by these fixtures. One test executes a real
Node child process that prints `Compiled successfully` then exits 1; it is a
process regression, not a real Next.js build. Tests also cover missing build,
affected version, bad environment, unclassified/tracing warnings, malformed and
stale evidence, unchanged runtime requirements and the existing Guardian/CLI.

As with the existing Guardian, trusted process observations and filesystem hashes
are assertions supplied by the host. This increment has no signed attestation,
artifact reader, build collector, Next app build or HTTP/browser/auth acceptance.
PASS is a deterministic evidence result and never publish/deploy permission.

Primary references:

- <https://nextjs.org/docs/messages/non-standard-node-env>
- <https://nextjs.org/docs/app/api-reference/config/next-config-js/output>
- <https://github.com/advisories/GHSA-7m27-7ghc-44w9>


## GUARDIAN-NEXT-HOST-001: authorized host collection

No second Guardian is introduced. `collectNextBuild` in
`src/guardian/next-build-collector.ts` produces observations for the existing
`reviewNextBuildEvidence` and `releaseGate`. The existing standards CLI `release`
mode also invokes the host checks when its trusted requirements contain
`releaseHost`; it never executes a build implicitly. The collector is an explicit
host-side library call, not a worker tool, MCP execution endpoint or new agent.

The host supplies `ReleaseHostRequirements`:

- `declaredStack`: `auto` or `next`; never supplied by worker JSON.
- `repositoryAlias`, `mission`, `assignmentId`, `storeDirectory`: existing registered
  host identity, `MissionContract` and private `ApprovalStore`. `canPerform(...,
  'verify', approvalContext(...))` checks the real host clock and current signed
  grants before execution, after execution and at each release review. No grant is
  created by the collector. Mission plan/base/branch and repository must match.
- `sourceSha256`: the host-reviewed source pin from `inspectReleaseSource(root)`.
- `dependenciesSha256`: the host pin of the local, lockfile-installed dependency
  directory from `directoryDigest(root + '/node_modules', 'dependencies')`.
- `timeoutMs`: explicit host bound (100 ms–30 min) for the owned build process group.
- `evidenceRecords`: optional host-selected `result-UUID` names in the same private
  ApprovalStore, each containing an existing `EvidenceContract` value authenticated
  by `writeExecutionRecord`. A trusted executor must persist its own observed evidence;
  signing a worker's claimed `done` is not authentication of completion. No evidence
  is manufactured or imported automatically. Missing referenced evidence blocks with
  `RELEASE_AUTHENTICATED_EVIDENCE_MISSING`. Only assignment completion evidence bound
  to this mission, assignment, planHash, branch, base SHA and selected human approval's
  dates is supported; arbitrary paths, worker evidence and mismatches block. The host
  reloads and authenticates the records at every authorization check, including release.
  Existing `canPerform` still verifies dependencies and live approval/revocation/expiry.
- `buildRecord`: the authenticated `result-UUID` returned by collection. It is an
  output reference selected by the host, not an arbitrary worker path.

The outer release policy keeps its existing run/root/branch/HEAD/start time,
Guardian verdict, runtime requirements and `nextBuild` security/environment
requirements. The latter must contain the exact host-read lockfile bytes, host
Node/platform, and approved advisory scope. This collector currently accepts
installation with unset `NODE_ENV` only; the host must establish that provenance
when installing and pinning dependencies. A later install cannot be inferred from
build logs. The build environment itself is freshly constructed and recorded.

Host sequence (all objects below come from approved host configuration):

```ts
const collected = await collectNextBuild(trustedPolicy);
const decision = releaseGate(workerRuntimeReport, {
  ...trustedPolicy,
  releaseHost: { ...trustedPolicy.releaseHost, buildRecord: collected.recordName },
  now: new Date().toISOString(),
});
```

`workerRuntimeReport` contains runtime observations only. Including `nextBuild`,
requirements, exclusions, approvals or a host context in worker observations
blocks; no spread/merge of worker policy into host policy is permitted. A valid
build does not bypass required HTTP/browser/auth/business checks or worker Guardian.

### Source, execution and artifact binding

The collector requires a canonical standalone npm project, clean Git state, one
stable resolved Next installation and matching manifest/lock declarations. npm
v2/v3 lockfiles are supported. Workspaces, multiple lockfiles, linked Next packages,
source symlinks, external dependency symlinks, `.env*` source files and custom build
output directories are deliberately unsupported and fail closed. Local npm `.bin`
symlinks resolving inside the pinned dependency directory are accepted.

Source hashes cover file bytes, executable bits and names, including ignored and
untracked files; only root `.git`, `node_modules` and `.next` are excluded. HEAD,
branch, manifest, lockfile and source content are observed before/after execution
and again at release review. Dependencies are independently pinned and rehashed.
Dirty source cannot be certified by a prior clean revision or by trusting status
strings supplied by a worker.

Only the pinned local `node_modules/next/dist/bin/next` is invoked with the current
host Node executable and the literal argument `build`, without a shell or npm
lifecycle scripts. Both streams are drained through process close, with actual
exit/signal/timeout, wall timestamps, monotonic duration, PID, Node binary hash,
argv and an allowlisted environment. No parent credentials, `NODE_OPTIONS`, proxy
or provider variables are inherited. `HOME`/`TMPDIR` are private run directories;
`NODE_ENV=production`, telemetry disabled. The explicitly bounded process group is
terminated only on its own timeout; unrelated processes are never addressed.
Parent `close` alone does not finish collection: the host probes the owned POSIX group.
On timeout, SIGTERM escalates to SIGKILL after one second even if the parent closed.
Collection waits for confirmed group absence and drained pipes, with a final two-second
bound after escalation. Unconfirmed termination records
`NEXT_BUILD_PROCESS_GROUP_UNCONFIRMED` and remains blocking; open pipes are destroyed
and the host timer is cleared. A confirmed absent group is never signalled again.
This is not isolation against processes deliberately escaping the group (`setsid`,
for example); the OS owner/root and exclusive host control remain trusted. Windows
process groups are unsupported and block before spawn.

Read-only Git inspection imposes `-c core.fsmonitor=false` on each command, including
when the repository configures a hook. Each Git command has a three-second timeout
and SIGKILL termination, plus a 1 MiB output bound. This does not alter repository or
user configuration.

`.next` must be absent at entry. The collector never deletes a prior build to make
it pass. `BUILD_ID` must be a fresh regular file created during this process; the
entire `.next` tree is hashed, so a later artifact replacement also blocks.
Custom `distDir` requires a future approved contract, not a guessed artifact path.

### Reproducible evidence

The existing `ApprovalStore.writeExecutionRecord` persists immutable HMAC-bound
`attempt-UUID` and `result-UUID` records outside source, with its existing private
ownership/mode checks. The `next-host-build/1` result contains:

- run and approved plan hash; exact Next requirements hash;
- full source identity snapshots and dependency hashes before/after;
- the unchanged Next build observation contract;
- artifact content/tree hashes, size, BUILD_ID and creation observation;
- process identity/environment, raw-stream SHA-256 values, redacted stdout/stderr,
  completeness/redaction markers and blocking reason codes.

Raw streams stay in memory only. Known parent secret values and recognizable
credential formats are redacted across chunk boundaries before persistence.
Diagnostics are classified on the originals so redaction cannot erase a blocking
failure. Capture above 1 MiB is marked incomplete and blocks; it is never certified
as a complete log. No worker can authenticate a replacement record without the
trusted store key. The live release check also rejects records from other runs,
plans, source trees, dependency installations, or altered artifacts.

### Validation and explicit limits

`host-release.test.ts` covers mandatory activation, legacy compatibility and the
narrow cache diagnostic. `next-build-collector.test.ts` uses real Node child
processes and synthetic Next binaries for adversarial cases. Its explicit
`AMON_NEXT_REAL_FIXTURE` opt-in runs an authentic locally installed Next build only
under `/private/tmp/GUARDIAN-NEXT-HOST-001/real-next-fixture*`; ordinary unit/full
suite runs do not install packages, fetch advisories or run product repositories.
The fixture creates disposable Git history and synthetic test-host grants solely
inside its temporary scope. It never grants permission for AMON product work.

Trust limits remain those of the existing local approval host: the same OS owner,
root, a stolen store key, and arbitrary hostile code already approved for execution
are outside its security boundary. File snapshots are not an OS filesystem sandbox
and do not guarantee detection of a concurrent write-and-restore between samples.
The host must exclusively own the approved build root while collecting/reviewing.
Secret redaction is defense in depth, not a guarantee for arbitrary encoded secrets;
credential-bearing repositories are unsupported. The pinned dependency installation
must itself be obtained from the approved lockfile by the host. This increment does
not claim a complete live advisory inventory or web/runtime acceptance.

Convergence PR #11 is a **later QA candidate only**. This task neither runs commands
there nor changes its code, dependencies, evidence, branch or deployment.


### Local review closure: declared/resolved/installed version coherence

`inspectReleaseManifests` additionally requires the resolved stable Next version
in `packages["node_modules/next"].version` to satisfy the identical root declaration
in both manifest and lockfile. A resolved/installed `15.1.2` with declaration
`^16.4.6` blocks with `RELEASE_NEXT_RANGE_MISMATCH`; `^15.0.0` with `15.1.2` remains
valid. The existing `installedDependencies` check still requires the installed
package version to equal the resolved version, before execution and at review;
its implementation and dependency pin checks are unchanged.

Supported declaration grammar (maximum 1024 characters): full stable `M.m.p`
components, optional `=`, `^`, `~`, `>`, `>=`, `<` or `<=`; whitespace-separated
conjunctions and `||` alternatives. Whitespace around clauses and after operators
is accepted. Components are canonical nonnegative safe integers, without leading
zeros. Caret preserves the leftmost nonzero component (`^0.2.5` stays in `0.2`,
`^0.0.4` is exactly `0.0.4` for stable versions); tilde preserves major/minor.
These supported semantics follow the npm reference:
https://github.com/npm/node-semver#caret-ranges-123-025-004 .

Unsupported declarations block with `RELEASE_NEXT_RANGE_UNSUPPORTED`: partials,
wildcards, tags, `v` prefixes, prereleases/build metadata, hyphen ranges, comma
separators, package aliases/URLs/paths, empty alternatives or unknown syntax. Every
alternative is validated even if another alternative already matches. No coercion
or dependency/package-lock change is used. Noncanonical or unsupported resolved
versions block with `RELEASE_NEXT_VERSION_INVALID`. Both the explicit host path and
automatic detection retain these diagnostics.

Publication remains unprepared and unauthorized. After a new human approval, the
future PR must use a **new branch based on origin/main at 400cf27b**, not the branch
or PR #14 already merged. This local closure does not move or create branches.
