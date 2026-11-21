fn native_host() {
    let target = std::env::var("TARGET").unwrap();
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let path = std::path::PathBuf::from(format!("binaries/nedra-native-host-{target}{suffix}"));
    const STAND_IN: &[u8] = b"#!/bin/sh\nexit 3\n";
    println!("cargo:rerun-if-changed={}", path.display());
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    match std::fs::read(&path) {
        Ok(content) if content == STAND_IN && release => panic!(
            "{} is a stand-in: run `node build-native-host.mjs` in desktop/ first",
            path.display()
        ),
        Ok(_) => return,
        Err(_) if release => panic!(
            "{} is missing: run `node build-native-host.mjs` in desktop/ first",
            path.display()
        ),
        Err(_) => {}
    }
    std::fs::create_dir_all("binaries").unwrap();
    std::fs::write(&path, STAND_IN).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn main() {
    native_host();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/macos.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("nedra_native");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=native/macos.m");
        build_biometric();
    }
    let commands = vec![
        "core_request",
        "core_cancel",
        "core_status",
        "core_restart",
        "vault_lock",
        "menu_state",
        "clipboard_write",
        "clipboard_clear",
        "choose_backup",
        "backup_export",
        "backup_import",
        "save_file",
        "open_external",
        "biometric_available",
        "biometric_status",
        "biometric_login_options",
        "biometric_enroll",
        "biometric_login",
        "biometric_remove",
        "update_check",
        "update_install",
        "update_cancel",
        "security_key_register",
        "security_key_answer",
        "security_key_cancel",
        "extension_status",
        "extension_set_enabled",
        "extension_unpair",
        "extension_pairing_answer",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(Box::leak(commands.into_boxed_slice())),
    ))
    .expect("failed to run tauri-build");
}

fn build_biometric() {
    let source = "native/biometric.swift";
    println!("cargo:rerun-if-changed={source}");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("unsupported macOS architecture {other:?}"),
    };
    let status = std::process::Command::new("swiftc")
        .args(["-parse-as-library", "-emit-library", "-static", "-O"])
        .args(["-module-name", "nedra_biometric"])
        .args(["-target", &format!("{architecture}-apple-macos11.0")])
        .arg("-o")
        .arg(out.join("libnedra_biometric.a"))
        .arg(source)
        .status()
        .expect("run swiftc (install the Xcode Command Line Tools)");
    assert!(status.success(), "swiftc failed");
    let toolchain = std::process::Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .expect("run xcrun");
    let swiftc = std::path::PathBuf::from(String::from_utf8(toolchain.stdout).unwrap().trim());
    let runtime = swiftc
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("lib/swift/macosx");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-search=native={}", runtime.display());
    println!("cargo:rustc-link-search=native=/usr/lib/swift");
    println!("cargo:rustc-link-lib=static=nedra_biometric");
    for framework in ["CryptoKit", "Foundation", "LocalAuthentication", "Security"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
