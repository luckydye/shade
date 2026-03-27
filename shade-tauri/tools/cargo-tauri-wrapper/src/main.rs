use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .expect("wrapper crate must live under shade-tauri/tools");
    let script_path = project_root.join("scripts/cargo-tauri.sh");

    let error = Command::new(script_path)
        .args(std::env::args_os().skip(1))
        .exec();

    panic!("failed to exec cargo-tauri wrapper script: {error}");
}
