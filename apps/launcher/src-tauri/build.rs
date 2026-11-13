use std::path::PathBuf;

fn main() {
    // Launcher Preview release (TMHUB_RELEASE_PREVIEW=1): cfg `release_preview`, read as crate::RELEASE_PREVIEW.
    println!("cargo:rerun-if-env-changed=TMHUB_RELEASE_PREVIEW");
    println!("cargo:rerun-if-env-changed=TMHUB_PUBLIC_BUILD");
    println!("cargo:rustc-check-cfg=cfg(release_preview)");
    let preview = std::env::var("TMHUB_RELEASE_PREVIEW").as_deref() == Ok("1");
    if preview {
        println!("cargo:rustc-cfg=release_preview");
    }

    // Embedded catalog (addons.rs, suggest.rs, as $OUT_DIR/catalog.json). Public builds embed the reduced catalog
    // without the entries release-policy.json hides (packages/catalog/public-catalog.mjs; the launcher's vite
    // build writes it before cargo runs), so their URLs are not in the exe at all.
    let public = preview || std::env::var("TMHUB_PUBLIC_BUILD").as_deref() == Ok("1");
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../../packages/catalog");
    let src = if public { dir.join("generated/catalog.public.json") } else { dir.join("catalog.json") };
    println!("cargo:rerun-if-changed={}", src.display());
    let json = std::fs::read_to_string(&src).unwrap_or_else(|e| {
        panic!("{}: {e} (public builds: run the launcher's vite build first, or node packages/catalog/public-catalog.mjs)", src.display())
    });
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("catalog.json");
    std::fs::write(out, json).unwrap();

    tauri_build::build()
}
