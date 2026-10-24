//! Machine-wide names, fixed at compile time by `build.rs` from
//! `SRT_WIN_NAMESPACE`. Upstream's names when the variable is unset.

include!(concat!(env!("OUT_DIR"), "/namespace.rs"));
