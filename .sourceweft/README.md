# SourceWeft fork of sandbox-runtime

This fork carries a small patch set on top of upstream releases of
[anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime).

## Patches

1. **Windows namespace** — every machine-wide name srt-win creates (HKLM/HKCU
   keys, the sandbox account and groups, state directories, the default WFP
   sublayer) is fixed at build time from `SRT_WIN_NAMESPACE`,
   `SRT_WIN_SANDBOX_USER` and `SRT_WIN_SUBLAYER_GUID`
   (`vendor/srt-win-src/build.rs`). The TS side takes the same namespace from
   `--define __SRT_WIN_NAMESPACE__='"<name>"'` when bundled
   (`src/sandbox/windows-namespace.ts`). Unset, every name is upstream's.
2. **This directory and the sync workflow** — always the last commit.

## Branches and tags

- `main` mirrors upstream and is not used.
- `sourceweft/windows-namespace` (default branch) = the newest upstream
  release that passed our checks, plus the patches above.
  `.sourceweft/upstream-version` records that release.
- `<upstream tag>-sourceweft.<n>` tags mark each published result. Consumers
  pin one of these tags.

## Sync

`.github/workflows/sourceweft-sync.yml` runs daily and on demand. It replays
the patches onto the newest upstream `v*` tag, runs upstream's Linux test
suite, builds srt-win with upstream names (`cargo test`, `clippy`) and with
ours, and checks on Windows x64 and arm64 that our install coexists with
upstream's default install of the new and the previous release. Only when all
of that passes does it move the branch and push the tag. A conflict or a
failed check stops the run and changes nothing.

Pushing needs the `SYNC_TOKEN` secret: a fine-grained token for this
repository with **Contents** and **Workflows** read/write (upstream commits
change `.github/workflows`, which the default `GITHUB_TOKEN` may not push).

Upstream's own workflows (`integration-tests.yml`, `release.yml`) are disabled
in this fork; they would run paid macOS jobs and try to publish to npm.

Our values: namespace `sourceweft`, account `sourceweft-sandbox`, sublayer
`7d1c3a52-9e4b-4f6a-8c21-5b0e9f3d6a17`, proxy ports `60180-60189`.
