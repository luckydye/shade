use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

// JSON-RPC types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
  pub jsonrpc: String,
  pub id: u32,
  pub method: String,
  pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
  pub jsonrpc: String,
  pub id: u32,
  pub result: Option<serde_json::Value>,
  pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
  pub code: i32,
  pub message: String,
  pub data: Option<serde_json::Value>,
}

// Image processing types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInput {
  #[serde(rename = "type")]
  pub input_type: String,
  pub path: Option<String>,
  pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageOperation {
  pub operation: String,
  pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessImageParams {
  pub image: ImageInput,
  pub operations: Vec<ImageOperation>,
  pub output_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessImageResult {
  pub image_data: String,
  pub width: u32,
  pub height: u32,
  pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCapabilities {
  pub supported_operations: Vec<String>,
  pub supported_input_formats: Vec<String>,
  pub supported_output_formats: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeResult {
  pub capabilities: ServerCapabilities,
  pub server_info: HashMap<String, String>,
}

// State management
pub struct ShadeProcess {
  child: Option<Child>,
  request_id: Arc<Mutex<u32>>,
  initialized: Arc<RwLock<bool>>,
}

impl ShadeProcess {
  pub fn new() -> Self {
    Self {
      child: None,
      request_id: Arc::new(Mutex::new(0)),
      initialized: Arc::new(RwLock::new(false)),
    }
  }

  pub async fn start(&mut self) -> Result<(), String> {
    if self.child.is_some() {
      return Ok(());
    }

    // Try to find shade binary in various locations
    let shade_paths = [
      "../../target/release/shade",
      "../../target/debug/shade",
      "../../../target/release/shade",
      "../../../target/debug/shade",
      "shade", // System PATH
    ];

    let mut shade_path = None;
    for path in &shade_paths {
      if std::path::Path::new(path).exists() {
        shade_path = Some(path);
        break;
      }
    }

    let shade_cmd = shade_path.unwrap_or(&"shade");
    let child = Command::new(shade_cmd)
      .arg("--socket")
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::inherit())
      .spawn()
      .map_err(|e| format!("Failed to start shade process: {}", e))?;

    self.child = Some(child);
    Ok(())
  }

  pub async fn stop(&mut self) -> Result<(), String> {
    if let Some(mut child) = self.child.take() {
      // Send shutdown message
      let _ = self.send_message("shutdown", None).await;

      // Wait for graceful shutdown or kill after timeout
      tokio::select! {
          _ = child.wait() => {},
          _ = tokio::time::sleep(tokio::time::Duration::from_secs(5)) => {
              let _ = child.kill().await;
          }
      }
    }
    *self.initialized.write().await = false;
    Ok(())
  }

  pub async fn send_message(
    &mut self,
    method: &str,
    params: Option<serde_json::Value>,
  ) -> Result<serde_json::Value, String> {
    if self.child.is_none() {
      return Err("Shade process not started".to_string());
    }

    let mut request_id = self.request_id.lock().await;
    *request_id += 1;
    let id = *request_id;
    drop(request_id);

    let request = JsonRpcRequest {
      jsonrpc: "2.0".to_string(),
      id,
      method: method.to_string(),
      params,
    };

    let request_json = serde_json::to_string(&request)
      .map_err(|e| format!("Failed to serialize request: {}", e))?;

    let message = format!(
      "Content-Length: {}\r\n\r\n{}",
      request_json.len(),
      request_json
    );

    // Send message
    if let Some(child) = &mut self.child {
      if let Some(stdin) = child.stdin.as_mut() {
        stdin
          .write_all(message.as_bytes())
          .await
          .map_err(|e| format!("Failed to write to shade process: {}", e))?;
        stdin
          .flush()
          .await
          .map_err(|e| format!("Failed to flush stdin: {}", e))?;
      } else {
        return Err("No stdin available".to_string());
      }

      // Read response
      if let Some(stdout) = child.stdout.as_mut() {
        let mut reader = BufReader::new(stdout);

        // Read Content-Length header
        let mut header_line = String::new();
        reader
          .read_line(&mut header_line)
          .await
          .map_err(|e| format!("Failed to read header: {}", e))?;

        if !header_line.starts_with("Content-Length:") {
          println!("Invalid format: {}", header_line);
          return Err("Invalid response format".to_string());
        }

        let content_length: usize = header_line
          .trim()
          .strip_prefix("Content-Length:")
          .ok_or("Invalid Content-Length header")?
          .trim()
          .parse()
          .map_err(|e| format!("Invalid content length: {}", e))?;

        // Read empty line
        let mut empty_line = String::new();
        reader
          .read_line(&mut empty_line)
          .await
          .map_err(|e| format!("Failed to read empty line: {}", e))?;

        // Read JSON content
        let mut buffer = vec![0u8; content_length];
        tokio::io::AsyncReadExt::read_exact(&mut reader, &mut buffer)
          .await
          .map_err(|e| format!("Failed to read response body: {}", e))?;

        let response_json = String::from_utf8(buffer)
          .map_err(|e| format!("Invalid UTF-8 in response: {}", e))?;

        let response: JsonRpcResponse = serde_json::from_str(&response_json)
          .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(error) = response.error {
          return Err(format!("Shade error: {}", error.message));
        }

        response
          .result
          .ok_or_else(|| "No result in response".to_string())
      } else {
        Err("No stdout available".to_string())
      }
    } else {
      Err("No child process available".to_string())
    }
  }

  pub async fn is_initialized(&self) -> bool {
    *self.initialized.read().await
  }
}

// Tauri commands
#[tauri::command]
async fn start_shade_process(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<(), String> {
  let mut process = state.lock().await;
  process.stop().await;
  process.start().await
}

#[tauri::command]
async fn stop_shade_process(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<(), String> {
  let mut process = state.lock().await;
  process.stop().await
}

#[tauri::command]
async fn initialize_shade(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<InitializeResult, String> {
  let mut process = state.lock().await;

  let client_info = serde_json::json!({
      "client_info": {
          "name": "shade-tauri-ui",
          "version": "1.0.0"
      }
  });

  let result = process
    .send_message("initialize", Some(client_info))
    .await?;
  *process.initialized.write().await = true;

  serde_json::from_value(result)
    .map_err(|e| format!("Failed to parse initialize result: {}", e))
}

#[tauri::command]
async fn process_image_base64(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
  image_data: String,
  operations: Vec<ImageOperation>,
  output_format: String,
) -> Result<ProcessImageResult, String> {
  let mut process = state.lock().await;

  if !process.is_initialized().await {
    return Err("Shade process not initialized".to_string());
  }

  let params = ProcessImageParams {
    image: ImageInput {
      input_type: "base64".to_string(),
      path: None,
      data: Some(image_data),
    },
    operations,
    output_format,
  };

  let params_value = serde_json::to_value(params)
    .map_err(|e| format!("Failed to serialize params: {}", e))?;

  let result = process
    .send_message("process_image", Some(params_value))
    .await?;

  serde_json::from_value(result)
    .map_err(|e| format!("Failed to parse process result: {}", e))
}

#[tauri::command]
async fn process_image_file(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
  file_path: String,
  operations: Vec<ImageOperation>,
  output_format: String,
) -> Result<ProcessImageResult, String> {
  let mut process = state.lock().await;

  if !process.is_initialized().await {
    return Err("Shade process not initialized".to_string());
  }

  let params = ProcessImageParams {
    image: ImageInput {
      input_type: "file".to_string(),
      path: Some(file_path),
      data: None,
    },
    operations,
    output_format,
  };

  let params_value = serde_json::to_value(params)
    .map_err(|e| format!("Failed to serialize params: {}", e))?;

  let result = process
    .send_message("process_image", Some(params_value))
    .await?;

  serde_json::from_value(result)
    .map_err(|e| format!("Failed to parse process result: {}", e))
}

#[tauri::command]
async fn get_shade_status(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<bool, String> {
  let process = state.lock().await;
  Ok(process.is_initialized().await)
}

#[tauri::command]
async fn read_image_file(file_path: String) -> Result<Vec<u8>, String> {
  match std::fs::read(&file_path) {
    Ok(data) => Ok(data),
    Err(e) => Err(format!("Failed to read file {}: {}", file_path, e)),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let shade_process = Arc::new(Mutex::new(ShadeProcess::new()));

  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(shade_process)
    .invoke_handler(tauri::generate_handler![
      start_shade_process,
      stop_shade_process,
      initialize_shade,
      process_image_base64,
      process_image_file,
      get_shade_status,
      read_image_file
    ])
    .setup(|app| {
      // Start the shade process on app startup
      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let state: State<Arc<Mutex<ShadeProcess>>> = app_handle.state();
        if let Err(e) = start_shade_process(state).await {
          eprintln!("Failed to start shade process: {}", e);
        }
      });
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
