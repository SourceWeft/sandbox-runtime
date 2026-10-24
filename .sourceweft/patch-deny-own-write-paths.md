# Patch: a host `denyRead` can hide srt's own `/tmp/claude`

Commit `sandbox: a denyRead of /tmp/claude hides srt's own TMPDIR`, second in
the queue (after the Windows namespace patch, before the `.sourceweft/` commit).

## What was wrong

`getDefaultWritePaths()` always lists `/tmp/claude` and `/private/tmp/claude`
(`SANDBOX_OWN_WRITE_PATHS`) as srt's own TMPDIR. `src/sandbox/sandbox-utils.ts`
removes only the two *home* conveniences when a `denyRead` covers them; the
TMPDIR entries are "never left out".

- **Linux.** An existing host `/tmp/claude` is in `allowOnly`, so it is bound
  writable. A `denyRead` of it mounts a tmpfs on the landing path, and
  `pushReadDenyDirMounts` then binds every allowed write path under that
  landing back over the tmpfs ("Re-bound write path wiped by denyRead tmpfs").
  The host directory is visible and writable again. A `denyWrite` of the same
  path is applied afterwards as a `--ro-bind`, so the directory ends up
  **readable and read-only**. The same happens through a `denyRead: ['/']`
  (expanded to a tmpfs over `/tmp`): `/tmp/claude` is restored over that tmpfs
  too, and a literal `denyRead` entry for it is skipped as "already hidden by a
  denyRead tmpfs".
- **macOS.** Seatbelt keeps read and write as separate operations: the
  `denyRead` for `/private/tmp/claude` is honoured today, and the write allow
  does not re-open reading. What the implicit path leaves is the directory
  *writable* despite a read deny (a write-only drop box). `denyWrite` closes
  that, which is why the product only noticed on Linux.

## The patch

`getDefaultWritePaths(readRules)` drops `/tmp/claude` / `/private/tmp/claude`
when a `denyRead` entry **covers it without covering the directory it sits
in**. So `denyRead: ['/tmp/claude']`, `'/tmp/claude/**'`, a `{ path, literal }`
entry, or a glob like `/tmp/clau*` hide it; `'/'`, `'/tmp'`, `'/private/tmp'`
do not, exactly as before. With no `denyRead` the function returns the same
list byte for byte. Everything else flows from the existing plumbing
(`defaultWritePathsUnder`, `getFsWriteConfig`, the wrap paths): once the path is
not in `allowOnly`, Linux has nothing to restore over the tmpfs, and macOS
neither allows writing it.

Why "without covering the parent": upstream's tests (and the stated intent of
the code) pin that `/`, `/tmp`, `/dev` leave the sandbox's own paths in place.
Requiring that a deny **names** the directory keeps that default and makes
the new behaviour an explicit request, so no config key or env var is needed.

Consequences the caller must handle: with `/tmp/claude` out of the write
paths, srt's default `TMPDIR=/tmp/claude` is not writable; point
`CLAUDE_CODE_TMPDIR` at a writable directory (the product already pins TMPDIR
inside the workspace). The Linux violation monitor still lists the full set of
default write paths (its existing behaviour for hidden home directories, where
a write lands in the deny's writable tmpfs), so it does not report this path.
On macOS a glob spelled with `/tmp` covers the `/tmp` spelling only; a literal
entry covers both.

Unchanged: stdio and device paths (`/dev/...`), the proxy sockets (created
under `os.tmpdir()`, not `/tmp/claude`), the seccomp helper and every
`allowWrite`. An explicit `allowWrite: ['/tmp/claude']` still wins over the
deny, as it does for the home conveniences.

## Tests

`test/sandbox/deny-own-tmpdir.test.ts` (new file, so upstream changes to
`default-write-paths.test.ts` cannot conflict):

- unit: which `denyRead` spellings drop it, which leave it (`/`, `/tmp`,
  `/private/tmp`, `/dev`, sibling and child paths), the rest of the list
  untouched, no-deny list identical, `getFsWriteConfig()` end to end;
- real sandbox (macOS Seatbelt, or Linux where `bwrapCanNamespace()`): an
  existing `/tmp/claude` holding a marker file is readable with no deny, not
  readable under `denyRead` + `denyWrite`; on Linux the bwrap argv has the
  `--tmpfs /tmp/claude` and no bind of it (and the binds as before without the
  deny); a command under the deny still gets a writable `TMPDIR`, stdio, the
  proxy environment, and the proxy/seccomp wrapper runs.

Existing tests are untouched. Results are in the PR description.

## Upstream

- Issue: <https://github.com/anthropics/sandbox-runtime/issues/611> (the same
  reproduction: Linux, `denyRead` + `denyWrite` of `/tmp/claude`, fixture still
  readable).
- PR: <https://github.com/anthropics/sandbox-runtime/pull/613> (open) filters
  the same two paths, but also under `/` and `/tmp`, rewrites the existing
  expectations in `default-write-paths.test.ts`, and is written against
  `string[]` read rules rather than the current `FilesystemPathEntry`. This
  patch is the narrower variant that keeps today's results for everything except
  an entry naming the directory; if #613 lands, drop this commit in the next sync
  (its replay will conflict in `sandbox-utils.ts`) and keep only
  `test/sandbox/deny-own-tmpdir.test.ts`, adjusting the `/`/`/tmp` cases.
- Upstream-ready description: *"`getDefaultWritePaths` keeps srt's own
  `/tmp/claude` writable even when `filesystem.denyRead` names it. On Linux it is
  then bound back over the deny's tmpfs, so an existing directory stays
  readable. Leave the TMPDIR directories out when a `denyRead` entry covers
  them without covering their parent (`/tmp`, `/`), so existing configs are
  unchanged."*

## How the sync workflow carries it

`sourceweft-sync.yml` replays `git rev-list --reverse <base>..HEAD` onto the new
upstream tag by cherry-picking each commit and then amends the **last** commit
with the new `.sourceweft/upstream-version`. The queue is therefore

1. `windows: compile-time namespace for machine-wide names`
2. `sandbox: a denyRead of /tmp/claude hides srt's own TMPDIR` (this patch:
   `src/sandbox/sandbox-utils.ts`, `test/sandbox/deny-own-tmpdir.test.ts`)
3. `sourceweft: sync workflow, CI harness and fork notes` (always last; also
   carries this note and the README entry)

The patch touches one function and one new test file. It can conflict only if
upstream edits `getDefaultWritePaths` or the `SANDBOX_OWN_WRITE_PATHS` block
(#613 would); the run then stops with the conflicting commit named in the step
summary and changes nothing. The Linux job runs upstream's suite plus the new
file with real bwrap.

**Landing.** The default branch is moved only by the sync workflow, so a merge
commit or a commit appended after `sourceweft: sync workflow…` would break the
"last commit carries `.sourceweft/`" rule. The PR branch is already in queue
order (commit 2 sits before the rewritten commit 3). To land it, a maintainer
force-moves the default branch to the PR head:

```bash
git push --force-with-lease=sourceweft/windows-namespace:17abc6e \
  origin sourceweft/deny-own-write-paths:sourceweft/windows-namespace
```

then dispatches the sync workflow with `force: true` (same upstream tag) to
build, verify and publish `v0.0.81-sourceweft.3`. Nothing here has been
pushed to the default branch or released.

## Adopting it in the product (not done)

1. Cut the release: the dispatch above produces the next
   `v<upstream>-sourceweft.<n>` for the then-newest upstream tag (so
   `v0.0.81-sourceweft.3` if no newer upstream release exists yet, otherwise
   `v<new>-sourceweft.1`). Read the tag and the `SHA256SUMS` asset from the
   Release; do not guess them.
2. `apps/desktop/sandbox-sidecar/package.json`: change the one
   `@anthropic-ai/sandbox-runtime` URL
   (`.../releases/download/<tag>/sandbox-runtime-<tag>.tgz`). Then
   `pnpm install` to refresh `pnpm-lock.yaml` (two `specifier`/`version` lines
   and the `resolution: {tarball: …}` entry; the tarball is a URL dependency,
   so there is no integrity hash in the lockfile). Verify the downloaded
   tarball against the Release's `SHA256SUMS` once by hand, and record the
   digest wherever the bundle build pins/checks it (the product's own
   `scripts/ci/sandbox-bundle.mjs` hashes what it packs).
3. `apps/desktop/sandbox-sidecar/src/policy.ts` `buildConfig`: add the same
   literal entries to `filesystem.denyRead` that it already puts in `denyWrite`
   (`deniedWritePaths(platform)` → `/tmp/claude` on Linux, plus
   `/private/tmp/claude` on darwin), keep the `denyWrite`. Update the
   `deniedWritePaths` doc comment (R15: "denyWrite takes precedence" → both
   deny kinds do). Per-command `perCommandConfig` stays as is; the merge into
   srt's config must keep this `denyRead` entry (it is in `buildConfig`'s, not
   the overlay's, which has `denyRead: []`).
4. `SANDBOX_PROTOCOL_VERSION`: **no bump** for this patch alone. It versions the
   wire (init/policy/wrap shapes), not the sandbox's filesystem contents; the
   `init` reply, `InitConfig` and ops are unchanged. Per the plan 2 notes, bump
   it (in `protocol.ts` and `sidecar.rs`) only if the same change also alters
   those. The sidecar bundle's content hash/manifest changes with the new srt
   regardless.
5. Product tests:
   - `sandbox-sidecar/tests/policy.test.ts`: the two assertions that pin
     `denyRead` (Linux: `["/", home, …]`; darwin: `[home, …]`) gain
     `{ path: "/tmp/claude", literal: true }` (+ `/private/tmp/claude` on
     darwin); keep the `denyWrite` assertions.
   - `src-tauri/tests/linux_sandbox.rs`: next to `cannot_write_srt_tmp_claude`
     add `cannot_read_srt_tmp_claude`, which writes a marker file into the
     host `/tmp/claude` (created by `ensure_tmp_claude`) and asserts a sandboxed
     `cat` of it fails and `ls /tmp/claude` shows nothing. Runs in the existing
     bwrap-enabled Linux job.
   - A macOS counterpart where the existing macOS sandbox tests live (reading
     is already denied there; assert it stays so and writing is refused).
6. Remove the `ensure_tmp_claude` comment that says srt treats an existing
   `/tmp/claude` as its own writable TMPDIR, once the new test replaces it.

## Verification status

See the PR description for what ran where.
