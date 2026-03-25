// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    env_logger::init();
    #[cfg(not(debug_assertions))]
    install_panic_hook();
    shade_tauri_lib::run();
}

#[cfg(not(debug_assertions))]
fn install_panic_hook() {
    use std::io::Write;

    std::panic::set_hook(Box::new(|info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };

        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let body = format!("[{}] panic at {}: {}\n", timestamp, location, msg);

        // Write to stderr so it's captured when a console is available.
        eprintln!("{}", body.trim());

        // Also persist to a crash log next to the binary or in a temp dir.
        let log_path = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("crash.log")))
            .unwrap_or_else(|| std::env::temp_dir().join("shade-crash.log"));

        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = f.write_all(body.as_bytes());
        }
    }));
}
