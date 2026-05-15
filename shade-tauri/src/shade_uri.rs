use tauri::Manager;
use crate::image_loaders::{load_camera_thumbnail_from_tauri, load_thumbnail_bytes};


pub(crate) fn shade_uri_not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}
pub(crate) fn shade_uri_error(message: impl AsRef<str>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(500)
        .header("Access-Control-Allow-Origin", "*")
        .body(message.as_ref().as_bytes().to_vec())
        .unwrap()
}
pub(crate) fn detect_thumb_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 3 && &bytes[0..3] == b"\xff\xd8\xff" {
        "image/jpeg"
    } else if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        "image/png"
    } else if bytes.len() >= 4 && &bytes[0..4] == b"RIFF" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}
pub(crate) fn shade_uri_ok(bytes: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    let mime = detect_thumb_mime(&bytes);
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        // Edit fingerprint is in the URL — safe to cache aggressively.
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .body(bytes)
        .unwrap()
}
/// Dispatch a `shade://` request. Supported URIs:
///
/// * `shade://thumb/<path>?edit=<fingerprint>` — local image / library thumb
/// * `shade://thumb/peer/<peer_id>/<path>?edit=<fingerprint>` — peer thumb
/// * `shade://thumb/camera/<host>/<path>` — camera thumb (no fingerprint)
pub async fn serve_shade_uri<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri();
    // Tauri rewrites the URI; the original path is available via `.path()`.
    // Strip leading `/` and the host portion if present.
    let raw_path = uri.path().trim_start_matches('/');
    // Detect prefix to decide route.
    if let Some(rest) = raw_path
        .strip_prefix("thumb/peer/")
        .or_else(|| raw_path.strip_prefix("peer/"))
    {
        let (peer_id, encoded_path) = match rest.split_once('/') {
            Some(pair) => pair,
            None => return shade_uri_not_found(),
        };
        let decoded = match urlencoding_decode(encoded_path) {
            Ok(p) => p,
            Err(_) => return shade_uri_not_found(),
        };
        let p2p = app.state::<crate::P2pState>();
        let peer = match p2p.0.read().await.as_ref() {
            Some(p) => p.clone(),
            None => return shade_uri_error("p2p not initialized"),
        };
        return match peer.get_peer_thumbnail(peer_id, &decoded).await {
            Ok(bytes) => shade_uri_ok(bytes),
            Err(error) => shade_uri_error(error.to_string()),
        };
    }
    if let Some(rest) = raw_path
        .strip_prefix("thumb/camera/")
        .or_else(|| raw_path.strip_prefix("camera/"))
    {
        let (host, encoded_path) = match rest.split_once('/') {
            Some(pair) => pair,
            None => return shade_uri_not_found(),
        };
        let decoded = match urlencoding_decode(encoded_path) {
            Ok(p) => p,
            Err(_) => return shade_uri_not_found(),
        };
        return match load_camera_thumbnail_from_tauri(app, host, &decoded).await {
            Ok(bytes) => shade_uri_ok(bytes),
            Err(error) => shade_uri_error(error),
        };
    }
    if let Some(rest) = raw_path
        .strip_prefix("thumb/")
        .or_else(|| Some(raw_path).filter(|p| !p.is_empty()))
    {
        let decoded = match urlencoding_decode(rest) {
            Ok(p) => p,
            Err(_) => return shade_uri_not_found(),
        };
        return match load_thumbnail_bytes(app.clone(), &decoded).await {
            Ok(bytes) => shade_uri_ok(bytes),
            Err(error) => shade_uri_error(error),
        };
    }
    shade_uri_not_found()
}
pub(crate) fn urlencoding_decode(input: &str) -> Result<String, std::string::FromUtf8Error> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out)
}
