//! Compile-time Windows namespace.
//!
//! Every machine-wide name srt-win creates (the HKLM/HKCU keys, the
//! sandbox account and its groups, the state directories, the WFP
//! sublayer) derives from `SRT_WIN_NAMESPACE`, so an embedder can ship
//! a build whose install never shares state with another application's
//! sandbox-runtime install. Unset, every name is upstream's.
//!
//! - `SRT_WIN_NAMESPACE`: `[A-Za-z0-9-]`, 1–40 chars (default
//!   `sandbox-runtime`).
//! - `SRT_WIN_SANDBOX_USER`: default account name, ≤20 chars (the SAM
//!   limit). Default `srt-sandbox`; required with a custom namespace.
//! - `SRT_WIN_SUBLAYER_GUID`: default WFP sublayer. Required with a
//!   custom namespace, so a renamed build never reuses upstream's
//!   sublayer by accident.

use std::{env, fs, path::PathBuf};

const UPSTREAM_NAMESPACE: &str = "sandbox-runtime";
const UPSTREAM_USER: &str = "srt-sandbox";
const UPSTREAM_SUBLAYER: &str = "2c5d0ad6-5f3b-4d4e-9b8f-1a3e7c9d0b21";

fn var(name: &str) -> Option<String> {
    println!("cargo:rerun-if-env-changed={name}");
    env::var(name).ok().filter(|v| !v.is_empty())
}

fn main() {
    let namespace = var("SRT_WIN_NAMESPACE").unwrap_or_else(|| UPSTREAM_NAMESPACE.into());
    let custom = namespace != UPSTREAM_NAMESPACE;
    assert!(
        (1..=40).contains(&namespace.len())
            && namespace.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "SRT_WIN_NAMESPACE must be 1-40 characters of [A-Za-z0-9-], got {namespace:?}"
    );

    let user = match var("SRT_WIN_SANDBOX_USER") {
        Some(user) => user,
        None if custom => panic!("SRT_WIN_SANDBOX_USER is required when SRT_WIN_NAMESPACE is set"),
        None => UPSTREAM_USER.into(),
    };
    assert!(
        (1..=20).contains(&user.len())
            && user.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "SRT_WIN_SANDBOX_USER must be 1-20 characters of [A-Za-z0-9_-], got {user:?}"
    );

    let sublayer = match var("SRT_WIN_SUBLAYER_GUID") {
        Some(guid) => guid,
        None if custom => panic!("SRT_WIN_SUBLAYER_GUID is required when SRT_WIN_NAMESPACE is set"),
        None => UPSTREAM_SUBLAYER.into(),
    };
    let hex: String = sublayer
        .trim_matches(|c| c == '{' || c == '}')
        .chars()
        .filter(|&c| c != '-')
        .collect();
    assert!(
        hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit()),
        "SRT_WIN_SUBLAYER_GUID must be a GUID, got {sublayer:?}"
    );
    assert!(
        !custom || !hex.eq_ignore_ascii_case(&UPSTREAM_SUBLAYER.replace('-', "")),
        "a custom SRT_WIN_NAMESPACE must not reuse upstream's sublayer GUID"
    );

    let generated = format!(
        "pub const NAMESPACE: &str = {namespace:?};\n\
         pub const REG_BASE: &str = {reg_base:?};\n\
         pub const REG_CRED: &str = {reg_cred:?};\n\
         pub const REG_CA: &str = {reg_ca:?};\n\
         pub const PERSIST_MARKER_KEY: &str = {marker:?};\n\
         pub const SANDBOX_USER: &str = {user:?};\n\
         pub const SANDBOX_GROUP: &str = {group:?};\n\
         pub const LEGACY_NET_GROUP: &str = {net_group:?};\n\
         pub const STATE_DIR_NAME: &str = {namespace:?};\n\
         pub const SUBLAYER_GUID: u128 = 0x{hex};\n",
        reg_base = format!(r"SOFTWARE\{namespace}"),
        reg_cred = format!(r"SOFTWARE\{namespace}\Cred"),
        reg_ca = format!(r"SOFTWARE\{namespace}\Ca"),
        marker = format!(r"Software\{namespace}\PersistentGrants"),
        group = format!("{namespace}-users"),
        net_group = format!("{namespace}-net"),
    );
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("namespace.rs");
    fs::write(out, generated).expect("write namespace.rs");
}
