use std::path::PathBuf;
use std::process::Command;

fn main() {
    link_clang_runtime();
    tauri_build::build()
}

/// llama.cpp's Metal code guards newer APIs with `@available`. When the deployment target is older
/// than those APIs (release builds with an older deployment target), clang turns each guard into a call to
/// `__isPlatformVersionAtLeast` from its own runtime library, which rustc's link line leaves out.
/// Linking that archive lets the linker take just the version check from it.
fn link_clang_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let output = match Command::new("xcrun").args(["--sdk", "macosx", "clang", "--print-resource-dir"]).output() {
        Ok(out) if out.status.success() => out,
        _ => {
            println!("cargo:warning=couldn't find clang's resource dir; release builds may fail to link __isPlatformVersionAtLeast");
            return;
        }
    };
    let resource_dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let lib_dir = resource_dir.join("lib").join("darwin");
    if !lib_dir.join("libclang_rt.osx.a").is_file() {
        println!("cargo:warning=no libclang_rt.osx.a in {}; release builds may fail to link", lib_dir.display());
        return;
    }
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
