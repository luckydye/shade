fn main() {
    tauri_build::build();

    // On iOS, our Swift helper functions (ios_list_photos etc.) are compiled by
    // Xcode after cargo runs. Allow them to be unresolved in the dylib — Xcode's
    // final link step provides them.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        let resource_dir = std::process::Command::new("xcrun")
            .args(["--toolchain", "default", "clang", "-print-resource-dir"])
            .output()
            .expect("xcrun must be available for iOS builds");
        assert!(
            resource_dir.status.success(),
            "failed to query the Clang resource directory"
        );

        let resource_dir = std::path::PathBuf::from(
            String::from_utf8(resource_dir.stdout)
                .expect("Clang resource directory must be valid UTF-8")
                .trim(),
        )
        .join("lib/darwin");

        println!(
            "cargo:rustc-link-search=native={}",
            resource_dir.display()
        );
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
