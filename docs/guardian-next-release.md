# Guardian Next.js release evidence — increment 1

`src/guardian/next-build.ts` adds a deterministic, read-only evidence check to the
existing Guardian and `releaseGate`. It starts no build, agent, server or network
request, changes no authorization, and supplies no acceptance override.

## Integration and authority

The human-approved host requirements select `nextBuild: NextBuildRequirements`
alongside the existing release requirements. For Next.js releases the host MUST
set this field; an omitted build then blocks even when the worker Guardian passed.
Existing non-Next callers retain their contract. This increment does not discover
frameworks from disk or automatically opt existing consumers into a new policy.

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
`NEXT_WARNING_UNCLASSIFIED`. Both block in this increment. There is no agent
allowlist or suppression. Findings point to combined stdout/stderr line numbers
instead of echoing potentially sensitive raw text. The host retains the full
logs; this library neither persists nor redacts them. Future diagnostic formats
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
