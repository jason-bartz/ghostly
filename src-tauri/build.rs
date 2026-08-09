fn main() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    build_apple_intelligence_bridge();

    // Meeting Mode bridges. Unlike the Apple Intelligence bridge these are not
    // Apple-Silicon-only: CoreAudio process taps and NSWorkspace both work on
    // Intel Macs running Sonoma, so gate on the OS alone.
    #[cfg(target_os = "macos")]
    build_meeting_bridges();

    generate_tray_translations();

    tauri_build::build()
}

/// A Swift source file compiled to a static library and linked into the binary.
#[cfg(target_os = "macos")]
struct SwiftBridge {
    /// Static library name. Must be unique across bridges — the linker uses a
    /// flat namespace, so exported symbols must not collide either.
    lib: &'static str,
    source: &'static str,
    header: &'static str,
    frameworks: &'static [&'static str],
}

/// Compiles the Meeting Mode Swift bridges.
///
/// Mirrors `build_apple_intelligence_bridge` but is table-driven and passes
/// `-parse-as-library`. Without that flag swiftc treats a lone source file as
/// a script and emits a spurious `_main`, which collides with the Rust
/// binary's own `main` once the archive member is pulled in.
#[cfg(target_os = "macos")]
fn build_meeting_bridges() {
    use std::env;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const BRIDGES: &[SwiftBridge] = &[
        SwiftBridge {
            lib: "ghostly_system_audio",
            source: "swift/system_audio.swift",
            header: "swift/system_audio_bridge.h",
            frameworks: &["CoreAudio", "AudioToolbox"],
        },
        SwiftBridge {
            lib: "ghostly_app_identity",
            source: "swift/app_identity.swift",
            header: "swift/app_identity_bridge.h",
            frameworks: &["AppKit"],
        },
    ];

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));

    let sdk_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .expect("Failed to locate macOS SDK")
            .stdout,
    )
    .expect("SDK path is not valid UTF-8")
    .trim()
    .to_string();

    let swiftc_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .expect("Failed to locate swiftc")
            .stdout,
    )
    .expect("swiftc path is not valid UTF-8")
    .trim()
    .to_string();

    // macOS 11 deployment target; the `@available(macOS 14.2, *)` checks in
    // system_audio.swift handle process-tap availability at runtime.
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".to_string());
    let target = match arch.as_str() {
        "x86_64" => "x86_64-apple-macosx11.0",
        _ => "arm64-apple-macosx11.0",
    };

    for bridge in BRIDGES {
        println!("cargo:rerun-if-changed={}", bridge.source);
        println!("cargo:rerun-if-changed={}", bridge.header);

        if !Path::new(bridge.source).exists() {
            panic!("Swift bridge source {} is missing!", bridge.source);
        }

        let object_path = out_dir.join(format!("{}.o", bridge.lib));
        let static_lib_path = out_dir.join(format!("lib{}.a", bridge.lib));

        let status = Command::new("xcrun")
            .args([
                "swiftc",
                "-target",
                target,
                "-sdk",
                &sdk_path,
                "-O",
                "-parse-as-library",
                "-import-objc-header",
                bridge.header,
                "-c",
                bridge.source,
                "-o",
                object_path.to_str().expect("object path is not UTF-8"),
            ])
            .status()
            .unwrap_or_else(|e| panic!("Failed to invoke swiftc for {}: {e}", bridge.lib));
        if !status.success() {
            panic!("swiftc failed to compile {}", bridge.source);
        }

        let status = Command::new("libtool")
            .args([
                "-static",
                "-o",
                static_lib_path.to_str().expect("lib path is not UTF-8"),
                object_path.to_str().expect("object path is not UTF-8"),
            ])
            .status()
            .unwrap_or_else(|e| panic!("Failed to run libtool for {}: {e}", bridge.lib));
        if !status.success() {
            panic!("libtool failed for {}", bridge.lib);
        }

        println!("cargo:rustc-link-lib=static={}", bridge.lib);
        for framework in bridge.frameworks {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }

    // Swift runtime search paths. The Apple Intelligence bridge emits these
    // too, but it is Apple-Silicon-gated and may not run — duplicates are
    // harmless, a missing path is a link error.
    let toolchain_swift_lib = Path::new(&swiftc_path)
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("lib/swift/macosx"))
        .expect("Unable to determine Swift toolchain lib directory");

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!(
        "cargo:rustc-link-search=native={}",
        toolchain_swift_lib.display()
    );
    println!(
        "cargo:rustc-link-search=native={}",
        Path::new(&sdk_path).join("usr/lib/swift").display()
    );
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}

/// Generate tray menu translations from frontend locale files.
///
/// Source of truth: src/i18n/locales/*/translation.json
/// The English "tray" section defines the struct fields.
fn generate_tray_translations() {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    let out_dir = std::env::var("OUT_DIR").unwrap();
    let locales_dir = Path::new("../src/i18n/locales");

    println!("cargo:rerun-if-changed=../src/i18n/locales");

    // Collect all locale translations
    let mut translations: BTreeMap<String, serde_json::Value> = BTreeMap::new();

    for entry in fs::read_dir(locales_dir).unwrap().flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let lang = path.file_name().unwrap().to_str().unwrap().to_string();
        let json_path = path.join("translation.json");

        println!("cargo:rerun-if-changed={}", json_path.display());

        let content = fs::read_to_string(&json_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();

        if let Some(tray) = parsed.get("tray").cloned() {
            translations.insert(lang, tray);
        }
    }

    // English defines the schema
    let english = translations.get("en").unwrap().as_object().unwrap();
    let fields: Vec<_> = english
        .keys()
        .map(|k| (camel_to_snake(k), k.clone()))
        .collect();

    // Generate code
    let mut out = String::from(
        "// Auto-generated from src/i18n/locales/*/translation.json - do not edit\n\n",
    );

    // Struct
    out.push_str("#[derive(Debug, Clone)]\npub struct TrayStrings {\n");
    for (rust_field, _) in &fields {
        out.push_str(&format!("    pub {rust_field}: String,\n"));
    }
    out.push_str("}\n\n");

    // Static map
    out.push_str(
        "pub static TRANSLATIONS: Lazy<HashMap<&'static str, TrayStrings>> = Lazy::new(|| {\n",
    );
    out.push_str("    let mut m = HashMap::new();\n");

    for (lang, tray) in &translations {
        out.push_str(&format!("    m.insert(\"{lang}\", TrayStrings {{\n"));
        for (rust_field, json_key) in &fields {
            let val = tray.get(json_key).and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!(
                "        {rust_field}: \"{}\".to_string(),\n",
                escape_string(val)
            ));
        }
        out.push_str("    });\n");
    }

    out.push_str("    m\n});\n");

    fs::write(Path::new(&out_dir).join("tray_translations.rs"), out).unwrap();

    println!(
        "cargo:warning=Generated tray translations: {} languages, {} fields",
        translations.len(),
        fields.len()
    );
}

fn camel_to_snake(s: &str) -> String {
    s.chars()
        .enumerate()
        .fold(String::new(), |mut acc, (i, c)| {
            if c.is_uppercase() && i > 0 {
                acc.push('_');
            }
            acc.push(c.to_lowercase().next().unwrap());
            acc
        })
}

fn escape_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn build_apple_intelligence_bridge() {
    use std::env;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const REAL_SWIFT_FILE: &str = "swift/apple_intelligence.swift";
    const STUB_SWIFT_FILE: &str = "swift/apple_intelligence_stub.swift";
    const BRIDGE_HEADER: &str = "swift/apple_intelligence_bridge.h";

    println!("cargo:rerun-if-changed={REAL_SWIFT_FILE}");
    println!("cargo:rerun-if-changed={STUB_SWIFT_FILE}");
    println!("cargo:rerun-if-changed={BRIDGE_HEADER}");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let object_path = out_dir.join("apple_intelligence.o");
    let static_lib_path = out_dir.join("libapple_intelligence.a");

    let sdk_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .expect("Failed to locate macOS SDK")
            .stdout,
    )
    .expect("SDK path is not valid UTF-8")
    .trim()
    .to_string();

    // Check if the SDK supports FoundationModels (required for Apple Intelligence)
    let framework_path =
        Path::new(&sdk_path).join("System/Library/Frameworks/FoundationModels.framework");
    let has_foundation_models = framework_path.exists();

    let source_file = if has_foundation_models {
        println!("cargo:warning=Building with Apple Intelligence support.");
        REAL_SWIFT_FILE
    } else {
        println!("cargo:warning=Apple Intelligence SDK not found. Building with stubs.");
        STUB_SWIFT_FILE
    };

    if !Path::new(source_file).exists() {
        panic!("Source file {} is missing!", source_file);
    }

    let swiftc_path = String::from_utf8(
        Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .expect("Failed to locate swiftc")
            .stdout,
    )
    .expect("swiftc path is not valid UTF-8")
    .trim()
    .to_string();

    let toolchain_swift_lib = Path::new(&swiftc_path)
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join("lib/swift/macosx"))
        .expect("Unable to determine Swift toolchain lib directory");
    let sdk_swift_lib = Path::new(&sdk_path).join("usr/lib/swift");

    // Use macOS 11.0 as deployment target for compatibility
    // The @available(macOS 26.0, *) checks in Swift handle runtime availability
    // Weak linking for FoundationModels is handled via cargo:rustc-link-arg below
    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-target",
            "arm64-apple-macosx11.0",
            "-sdk",
            &sdk_path,
            "-O",
            "-import-objc-header",
            BRIDGE_HEADER,
            "-c",
            source_file,
            "-o",
            object_path
                .to_str()
                .expect("Failed to convert object path to string"),
        ])
        .status()
        .expect("Failed to invoke swiftc for Apple Intelligence bridge");

    if !status.success() {
        panic!("swiftc failed to compile {source_file}");
    }

    let status = Command::new("libtool")
        .args([
            "-static",
            "-o",
            static_lib_path
                .to_str()
                .expect("Failed to convert static lib path to string"),
            object_path
                .to_str()
                .expect("Failed to convert object path to string"),
        ])
        .status()
        .expect("Failed to create static library for Apple Intelligence bridge");

    if !status.success() {
        panic!("libtool failed for Apple Intelligence bridge");
    }

    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-lib=static=apple_intelligence");
    println!(
        "cargo:rustc-link-search=native={}",
        toolchain_swift_lib.display()
    );
    println!("cargo:rustc-link-search=native={}", sdk_swift_lib.display());
    println!("cargo:rustc-link-lib=framework=Foundation");

    if has_foundation_models {
        // Use weak linking so the app can launch on systems without FoundationModels
        println!("cargo:rustc-link-arg=-weak_framework");
        println!("cargo:rustc-link-arg=FoundationModels");
    }

    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
