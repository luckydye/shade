use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Shade process manager
pub struct ShadeProcess {
  child: Option<Child>,
  stdin: Option<Arc<Mutex<tokio::process::ChildStdin>>>,
  message_id_counter: u64,
  pending_requests: HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>,
}

impl ShadeProcess {
  pub fn new() -> Self {
    Self {
      child: None,
      stdin: None,
      message_id_counter: 0,
      pending_requests: HashMap::new(),
    }
  }

  pub fn next_message_id(&mut self) -> u64 {
    self.message_id_counter += 1;
    self.message_id_counter
  }

  pub fn is_running(&self) -> bool {
    self.child.is_some()
  }

  pub fn get_stdin(&self) -> Option<Arc<Mutex<tokio::process::ChildStdin>>> {
    self.stdin.clone()
  }
}

/// JSON-RPC 2.0 Message structure
#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcMessage {
  pub jsonrpc: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub id: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub method: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub params: Option<serde_json::Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub result: Option<serde_json::Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<JsonRpcError>,
  #[serde(skip_serializing_if = "Vec::is_empty", default)]
  pub binary_attachments: Vec<BinaryAttachment>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcError {
  pub code: i32,
  pub message: String,
  pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BinaryAttachment {
  pub id: String,
  pub content_type: String,
  pub size: usize,
}

/// Image processing request parameters
#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessImageRequest {
  pub image: ImageInput,
  pub operations: Vec<OperationSpec>,
  pub output_format: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ImageInput {
  #[serde(rename = "file")]
  File { path: String },
  #[serde(rename = "base64")]
  Base64 { data: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OperationSpec {
  pub operation: String,
  pub params: serde_json::Value,
}

/// Process image result
#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessImageResult {
  pub image_attachment_id: String,
  pub width: u32,
  pub height: u32,
  pub format: String,
}

/// Initialize the shade process
async fn start_shade_process(state: State<'_, Arc<Mutex<ShadeProcess>>>) -> Result<(), String> {
  let mut process = state.lock().await;

  if process.is_running() {
    return Ok(());
  }

  // Start the shade process in socket mode
  let mut child = Command::new("../../../target/release/shade")
    .arg("--socket")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true) // Automatically kill child when dropped
    .spawn()
    .map_err(|e| format!("Failed to start shade process: {}", e))?;

  let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
  let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

  // Store the handles for communication
  let stdin = Arc::new(Mutex::new(stdin));
  let stdout = Arc::new(Mutex::new(BufReader::new(stdout)));

  process.stdin = Some(stdin.clone());
  process.child = Some(child);

  // Initialize the shade server
  send_initialize_request(stdin.clone()).await?;

  drop(process); // Release the lock before spawning the reader task

  // Spawn a task to handle incoming messages
  let state_clone = state.inner().clone();
  tokio::spawn(async move {
    handle_incoming_messages(stdout, state_clone).await;
  });

  Ok(())
}

/// Send initialize request to shade server
async fn send_initialize_request(
  stdin: Arc<Mutex<tokio::process::ChildStdin>>,
) -> Result<(), String> {
  let message = JsonRpcMessage {
    jsonrpc: "2.0".to_string(),
    id: Some(1), // Use fixed ID for initialization
    method: Some("initialize".to_string()),
    params: Some(serde_json::json!({
      "client_info": {
        "name": "Tauri UI",
        "version": "1.0.0"
      }
    })),
    result: None,
    error: None,
    binary_attachments: Vec::new(),
  };

  let json = serde_json::to_string(&message)
    .map_err(|e| format!("Failed to serialize message: {}", e))?;

  let mut stdin_lock = stdin.lock().await;
  stdin_lock.write_all(json.as_bytes()).await
    .map_err(|e| format!("Failed to write to stdin: {}", e))?;
  stdin_lock.write_all(b"\n").await
    .map_err(|e| format!("Failed to write newline: {}", e))?;
  stdin_lock.flush().await
    .map_err(|e| format!("Failed to flush stdin: {}", e))?;

  Ok(())
}

/// Handle incoming messages from shade process
async fn handle_incoming_messages(
  stdout: Arc<Mutex<BufReader<tokio::process::ChildStdout>>>,
  state: Arc<Mutex<ShadeProcess>>,
) {
  loop {
    let mut line = String::new();

    let bytes_read = {
      let mut stdout_lock = stdout.lock().await;
      match stdout_lock.read_line(&mut line).await {
        Ok(bytes) => bytes,
        Err(e) => {
          eprintln!("Failed to read from shade process: {}", e);
          break;
        }
      }
    };

    if bytes_read == 0 {
      eprintln!("Shade process stdout closed");
      break;
    }

    let line = line.trim();
    if line.is_empty() {
      continue;
    }

    match serde_json::from_str::<JsonRpcMessage>(line) {
      Ok(message) => {
        if let Some(id) = message.id {
          // This is a response to a request
          let mut process = state.lock().await;
          if let Some(sender) = process.pending_requests.remove(&id) {
            let result = if let Some(error) = message.error {
              serde_json::json!({ "error": error })
            } else {
              message.result.unwrap_or(serde_json::Value::Null)
            };
            let _ = sender.send(result);
          } else {
            println!("Received response for unknown request ID: {}", id);
          }
        } else if let Some(method) = &message.method {
          // Handle notifications/events from server
          println!("Received notification: {} - {:?}", method, message.params);
        }
      }
      Err(e) => {
        eprintln!("Failed to parse message from shade: {} - {}", e, line);
      }
    }
  }
}

/// Send a JSON-RPC request to the shade process
async fn send_request(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
  method: &str,
  params: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let (sender, receiver) = tokio::sync::oneshot::channel();
  let message_id;

  {
    let mut process = state.lock().await;
    if !process.is_running() {
      return Err("Shade process is not running".to_string());
    }

    message_id = process.next_message_id();
    process.pending_requests.insert(message_id, sender);
  }

  let message = JsonRpcMessage {
    jsonrpc: "2.0".to_string(),
    id: Some(message_id),
    method: Some(method.to_string()),
    params: Some(params),
    result: None,
    error: None,
    binary_attachments: Vec::new(),
  };

  let json = serde_json::to_string(&message)
    .map_err(|e| format!("Failed to serialize message: {}", e))?;

  // Get stdin handle from process
  let stdin_handle = {
    let process = state.lock().await;
    process.get_stdin().ok_or("No stdin available".to_string())?
  };

  {
    let mut stdin = stdin_handle.lock().await;
    stdin.write_all(json.as_bytes()).await
      .map_err(|e| format!("Failed to write to stdin: {}", e))?;
    stdin.write_all(b"\n").await
      .map_err(|e| format!("Failed to write newline: {}", e))?;
    stdin.flush().await
      .map_err(|e| format!("Failed to flush stdin: {}", e))?;
  }

  // Wait for response with timeout
  match tokio::time::timeout(std::time::Duration::from_secs(30), receiver).await {
    Ok(Ok(result)) => Ok(result),
    Ok(Err(_)) => Err("Request was cancelled".to_string()),
    Err(_) => Err("Request timed out".to_string()),
  }
}

/// Tauri command to process an image
#[tauri::command]
async fn process_image(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
  request: ProcessImageRequest,
) -> Result<ProcessImageResult, String> {
  let params = serde_json::to_value(request)
    .map_err(|e| format!("Failed to serialize request: {}", e))?;

  let result = send_request(state, "process_image", params).await?;

  serde_json::from_value(result)
    .map_err(|e| format!("Failed to parse result: {}", e))
}

/// Tauri command to get server capabilities
#[tauri::command]
async fn get_capabilities(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<serde_json::Value, String> {
  send_request(state, "capabilities", serde_json::Value::Null).await
}

/// Tauri command to check if shade process is running
#[tauri::command]
async fn is_shade_running(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<bool, String> {
  let process = state.lock().await;
  Ok(process.is_running())
}

/// Tauri command to restart shade process
#[tauri::command]
async fn restart_shade(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<(), String> {
  // Stop current process
  {
    let mut process = state.lock().await;
    if let Some(mut child) = process.child.take() {
      let _ = child.kill().await;
      let _ = child.wait().await;
    }
    process.stdin = None;
    process.pending_requests.clear();
  }

  // Start new process
  start_shade_process(state).await
}

/// Tauri command to stop shade process
#[tauri::command]
async fn stop_shade(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<(), String> {
  let mut process = state.lock().await;
  if let Some(mut child) = process.child.take() {
    // Send shutdown message first
    if let Some(stdin_handle) = process.get_stdin() {
      let message = JsonRpcMessage {
        jsonrpc: "2.0".to_string(),
        id: None, // Notification
        method: Some("shutdown".to_string()),
        params: None,
        result: None,
        error: None,
        binary_attachments: Vec::new(),
      };

      if let Ok(json) = serde_json::to_string(&message) {
        let mut stdin = stdin_handle.lock().await;
        let _ = stdin.write_all(json.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        let _ = stdin.flush().await;
      }
    }

    // Give it a moment to shutdown gracefully
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Force kill if still running
    let _ = child.kill().await;
    let _ = child.wait().await;
  }
  process.stdin = None;
  process.pending_requests.clear();
  Ok(())
}

/// Tauri command to get process status and stats
#[tauri::command]
async fn get_shade_status(
  state: State<'_, Arc<Mutex<ShadeProcess>>>,
) -> Result<serde_json::Value, String> {
  let process = state.lock().await;
  Ok(serde_json::json!({
    "running": process.is_running(),
    "pending_requests": process.pending_requests.len(),
    "message_counter": process.message_id_counter
  }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(Arc::new(Mutex::new(ShadeProcess::new())))
    .invoke_handler(tauri::generate_handler![
      process_image,
      get_capabilities,
      is_shade_running,
      restart_shade,
      stop_shade,
      get_shade_status
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
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        // Cleanup shade process on app close
        let app_handle = window.app_handle();
        let state: State<Arc<Mutex<ShadeProcess>>> = app_handle.state();
        tauri::async_runtime::block_on(async move {
          let _ = stop_shade(state).await;
        });
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
