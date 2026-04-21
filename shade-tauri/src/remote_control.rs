use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const REQUEST_EVENT: &str = "remote-control-request";
const PROTOCOL_VERSION: &str = "2025-03-26";
const SERVER_INFO_FILE: &str = "remote-control-server.json";
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct RemoteControlState(pub Arc<RemoteControlShared>);

impl Default for RemoteControlState {
    fn default() -> Self {
        Self(Arc::new(RemoteControlShared::default()))
    }
}

#[derive(Default)]
pub struct RemoteControlShared {
    pending: Mutex<HashMap<String, oneshot::Sender<UiToolResponse>>>,
    info: Mutex<Option<RemoteControlServerInfo>>,
}

#[derive(Serialize, Clone)]
pub struct RemoteControlServerInfo {
    pub protocol: String,
    pub transport: String,
    pub address: String,
    pub server_name: String,
    pub server_version: String,
    pub info_path: String,
}

#[derive(Serialize, Clone)]
struct UiToolRequest {
    request_id: String,
    tool_name: String,
    arguments: Value,
}

struct UiToolResponse {
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct SubmitRemoteControlResponseParams {
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn submit_remote_control_response(
    params: SubmitRemoteControlResponseParams,
    state: tauri::State<'_, RemoteControlState>,
) -> Result<(), String> {
    let sender = state
        .0
        .pending
        .lock()
        .map_err(|_| "remote control state lock poisoned".to_string())?
        .remove(&params.request_id)
        .ok_or_else(|| {
            format!("unknown remote control request: {}", params.request_id)
        })?;
    sender
        .send(UiToolResponse {
            result: params.result,
            error: params.error,
        })
        .map_err(|_| "remote control response channel is closed".to_string())
}

#[tauri::command]
pub fn get_remote_control_server_info(
    state: tauri::State<'_, RemoteControlState>,
) -> Result<RemoteControlServerInfo, String> {
    state
        .0
        .info
        .lock()
        .map_err(|_| "remote control state lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "remote control server is not initialized".to_string())
}

pub async fn start<R: Runtime>(
    app: tauri::AppHandle<R>,
    shared: Arc<RemoteControlShared>,
) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("failed to bind remote control server: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("failed to read remote control address: {error}"))?;
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let info_path = config_dir.join(SERVER_INFO_FILE);
    let info = RemoteControlServerInfo {
        protocol: "mcp-like".to_string(),
        transport: "tcp+jsonl".to_string(),
        address: address.to_string(),
        server_name: "shade-ui-control".to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
        info_path: info_path.display().to_string(),
    };
    write_server_info_file(&info_path, &info)?;
    {
        let mut slot = shared
            .info
            .lock()
            .map_err(|_| "remote control state lock poisoned".to_string())?;
        *slot = Some(info.clone());
    }
    tauri::async_runtime::spawn(async move {
        accept_loop(listener, app, shared).await;
    });
    Ok(())
}

fn write_server_info_file(
    path: &PathBuf,
    info: &RemoteControlServerInfo,
) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(info).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

async fn accept_loop<R: Runtime>(
    listener: TcpListener,
    app: tauri::AppHandle<R>,
    shared: Arc<RemoteControlShared>,
) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let app = app.clone();
                let shared = shared.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = handle_connection(stream, app, shared).await {
                        log::warn!("remote control connection failed: {error}");
                    }
                });
            }
            Err(error) => {
                log::error!("remote control accept failed: {error}");
                return;
            }
        }
    }
}

async fn handle_connection<R: Runtime>(
    stream: TcpStream,
    app: tauri::AppHandle<R>,
    shared: Arc<RemoteControlShared>,
) -> Result<(), String> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match handle_message(&app, &shared, &line).await {
            Ok(Some(response)) => response,
            Ok(None) => continue,
            Err(error) => jsonrpc_error(Value::Null, -32700, &error),
        };
        let body = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
        writer.write_all(&body).await.map_err(|e| e.to_string())?;
        writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn handle_message<R: Runtime>(
    app: &tauri::AppHandle<R>,
    shared: &Arc<RemoteControlShared>,
    line: &str,
) -> Result<Option<Value>, String> {
    let request: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| "remote control request is missing method".to_string())?;
    let id = request.get("id").cloned();
    if method == "notifications/initialized" && id.is_none() {
        return Ok(None);
    }
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let response = match method {
        "initialize" => jsonrpc_result(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "shade-ui-control",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        ),
        "ping" => jsonrpc_result(id, json!({})),
        "tools/list" => jsonrpc_result(id, json!({ "tools": tool_definitions() })),
        "tools/call" => {
            let params = params
                .as_object()
                .ok_or_else(|| "tools/call params must be an object".to_string())?;
            let tool_name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "tools/call params.name must be a string".to_string())?;
            let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
            let result = call_tool(app, shared, tool_name, arguments).await;
            match result {
                Ok(value) => jsonrpc_result(id, tool_call_result(value)),
                Err(message) => jsonrpc_result(id, tool_call_error(&message)),
            }
        }
        "shutdown" => jsonrpc_result(id, json!({})),
        _ => jsonrpc_error(id.unwrap_or(Value::Null), -32601, "method not found"),
    };
    Ok(Some(response))
}

async fn call_tool<R: Runtime>(
    app: &tauri::AppHandle<R>,
    shared: &Arc<RemoteControlShared>,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = shared
            .pending
            .lock()
            .map_err(|_| "remote control state lock poisoned".to_string())?;
        pending.insert(request_id.clone(), tx);
    }
    if let Err(error) = app.emit(
        REQUEST_EVENT,
        UiToolRequest {
            request_id: request_id.clone(),
            tool_name: tool_name.to_string(),
            arguments,
        },
    ) {
        let _ = shared
            .pending
            .lock()
            .map_err(|_| "remote control state lock poisoned".to_string())?
            .remove(&request_id);
        return Err(error.to_string());
    }
    let response = match tokio::time::timeout(RESPONSE_TIMEOUT, rx).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            let _ = shared
                .pending
                .lock()
                .map_err(|_| "remote control state lock poisoned".to_string())?
                .remove(&request_id);
            return Err("remote control UI disconnected".to_string());
        }
        Err(_) => {
            let _ = shared
                .pending
                .lock()
                .map_err(|_| "remote control state lock poisoned".to_string())?
                .remove(&request_id);
            return Err("remote control UI timed out".to_string());
        }
    };
    if let Some(error) = response.error {
        return Err(error);
    }
    Ok(response.result.unwrap_or(Value::Null))
}

fn jsonrpc_result(id: Option<Value>, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result,
    })
}

fn jsonrpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        },
    })
}

fn tool_call_result(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [
            {
                "type": "text",
                "text": text,
            }
        ],
        "structuredContent": value,
    })
}

fn tool_call_error(message: &str) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": message,
            }
        ],
        "isError": true,
    })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "get_app_state",
            "Return current UI, artboard, and layer state.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
        ),
        tool(
            "show_view",
            "Navigate to media or editor view.",
            json!({
                "type": "object",
                "properties": {
                    "view": {
                        "type": "string",
                        "enum": ["media", "editor"],
                    }
                },
                "required": ["view"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "list_media_libraries",
            "List available media libraries.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
        ),
        tool(
            "select_media_library",
            "Select library in media browser.",
            json!({
                "type": "object",
                "properties": {
                    "libraryId": { "type": "string" }
                },
                "required": ["libraryId"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "list_library_images",
            "List items inside one media library.",
            json!({
                "type": "object",
                "properties": {
                    "libraryId": { "type": "string" }
                },
                "required": ["libraryId"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "open_library_image",
            "Open one image from library by id, path, name, or file hash.",
            json!({
                "type": "object",
                "properties": {
                    "libraryId": { "type": "string" },
                    "mediaId": { "type": "string" },
                    "path": { "type": "string" },
                    "name": { "type": "string" },
                    "fileHash": { "type": "string" },
                    "mode": {
                        "type": "string",
                        "enum": ["replace", "append"],
                    }
                },
                "required": ["libraryId"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "open_image_path",
            "Open one local image path directly.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "mode": {
                        "type": "string",
                        "enum": ["replace", "append"],
                    }
                },
                "required": ["path"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "select_layer",
            "Select one layer by index.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 }
                },
                "required": ["layerIndex"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "add_layer",
            "Add adjustment, curves, ls_curve, or crop layer.",
            json!({
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["adjustment", "curves", "ls_curve", "crop"],
                    },
                    "position": { "type": "integer", "minimum": 0 }
                },
                "required": ["kind"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "delete_layer",
            "Delete one non-image layer by index.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 }
                },
                "required": ["layerIndex"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "move_layer",
            "Reorder one layer.",
            json!({
                "type": "object",
                "properties": {
                    "fromIndex": { "type": "integer", "minimum": 0 },
                    "toIndex": { "type": "integer", "minimum": 0 }
                },
                "required": ["fromIndex", "toIndex"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "set_layer_visible",
            "Change layer visibility.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 },
                    "visible": { "type": "boolean" }
                },
                "required": ["layerIndex", "visible"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "set_layer_opacity",
            "Change layer opacity.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 },
                    "opacity": { "type": "number" }
                },
                "required": ["layerIndex", "opacity"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "rename_layer",
            "Rename one layer.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 },
                    "name": { "type": ["string", "null"] }
                },
                "required": ["layerIndex"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "apply_layer_edit",
            "Apply crop or adjustment values to one layer.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 },
                    "op": {
                        "type": "string",
                        "enum": [
                            "tone",
                            "color",
                            "curves",
                            "ls_curve",
                            "vignette",
                            "sharpen",
                            "grain",
                            "glow",
                            "hsl",
                            "denoise",
                            "crop"
                        ]
                    },
                    "values": { "type": "object" }
                },
                "required": ["layerIndex", "op", "values"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "set_crop_rect",
            "Set crop rectangle values on crop layer.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "width": { "type": "number" },
                    "height": { "type": "number" },
                    "rotation": { "type": "number" }
                },
                "additionalProperties": false,
            }),
        ),
        tool(
            "set_layer_mask",
            "Create, replace, or remove mask on adjustment layer.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 },
                    "kind": {
                        "type": "string",
                        "enum": ["remove", "brush", "linear", "radial"],
                    },
                    "x1": { "type": "number" },
                    "y1": { "type": "number" },
                    "x2": { "type": "number" },
                    "y2": { "type": "number" },
                    "cx": { "type": "number" },
                    "cy": { "type": "number" },
                    "radius": { "type": "number" }
                },
                "required": ["layerIndex", "kind"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "set_viewport",
            "Set exact viewport center and zoom.",
            json!({
                "type": "object",
                "properties": {
                    "centerX": { "type": "number" },
                    "centerY": { "type": "number" },
                    "zoom": { "type": "number" }
                },
                "additionalProperties": false,
            }),
        ),
        tool(
            "pan_viewport",
            "Pan viewport by image-space or screen-space delta.",
            json!({
                "type": "object",
                "properties": {
                    "deltaX": { "type": "number" },
                    "deltaY": { "type": "number" },
                    "unit": {
                        "type": "string",
                        "enum": ["image", "screen"],
                    }
                },
                "required": ["deltaX", "deltaY"],
                "additionalProperties": false,
            }),
        ),
        tool(
            "paint_brush_mask",
            "Stamp brush mask on adjustment layer.",
            json!({
                "type": "object",
                "properties": {
                    "layerIndex": { "type": "integer", "minimum": 0 },
                    "cx": { "type": "number" },
                    "cy": { "type": "number" },
                    "radius": { "type": "number" },
                    "softness": { "type": "number" },
                    "erase": { "type": "boolean" }
                },
                "required": ["layerIndex", "cx", "cy", "radius", "softness"],
                "additionalProperties": false,
            }),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}
