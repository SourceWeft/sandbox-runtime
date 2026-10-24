/**
 * Windows namespace, fixed when the library is bundled. It must match the
 * `SRT_WIN_NAMESPACE` the srt-win binary was built with (see
 * `vendor/srt-win-src/build.rs`). An embedder that ships a renamed srt-win
 * bundles this library with `--define __SRT_WIN_NAMESPACE__='"<name>"'`;
 * otherwise the name is upstream's.
 */
declare const __SRT_WIN_NAMESPACE__: string | undefined

export const WINDOWS_NAMESPACE: string =
  typeof __SRT_WIN_NAMESPACE__ === 'string'
    ? __SRT_WIN_NAMESPACE__
    : 'sandbox-runtime'
