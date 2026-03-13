fn main() {
    tauri_build::build();

    // On iOS, our Swift helper functions (ios_list_photos etc.) are compiled by
    // Xcode after cargo runs. Allow them to be unresolved in the dylib — Xcode's
    // final link step provides them.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
