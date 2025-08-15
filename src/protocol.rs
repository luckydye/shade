use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader};

use crate::cli::OperationType;

/// Message ID for request/response correlation
pub type MessageId = u64;

/// Base structure for all messages following LSP-style protocol
#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
  pub jsonrpc: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub id: Option<MessageId>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub method: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub params: Option<serde_json::Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub result: Option<serde_json::Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<ResponseError>,
}

/// Error response structure
#[derive(Debug, Serialize, Deserialize)]
pub struct ResponseError {
  pub code: i32,
  pub message: String,
  pub data: Option<serde_json::Value>,
}

/// Standard error codes (following LSP convention)
pub mod error_codes {
  pub const PARSE_ERROR: i32 = -32700;
  pub const INVALID_REQUEST: i32 = -32600;
  pub const METHOD_NOT_FOUND: i32 = -32601;
  pub const INVALID_PARAMS: i32 = -32602;
  pub const INTERNAL_ERROR: i32 = -32603;
  pub const SERVER_ERROR_START: i32 = -32099;
  pub const SERVER_ERROR_END: i32 = -32000;
}

/// Image processing request parameters
#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessImageParams {
  /// Input image data as base64 string or file path
  pub image: ImageInput,
  /// Pipeline operations to apply
  pub operations: Vec<OperationSpec>,
  /// Output format (optional, defaults to "png")
  pub output_format: Option<String>,
}

/// Input image specification
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ImageInput {
  #[serde(rename = "file")]
  File { path: String },
  #[serde(rename = "base64")]
  Base64 { data: String },
  #[serde(rename = "blob")]
  Blob { data: Vec<u8> },
}

/// Operation specification for image processing
#[derive(Debug, Serialize, Deserialize)]
pub struct OperationSpec {
  pub operation: String,
  pub params: serde_json::Value,
}

/// Image processing response result
#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessImageResult {
  /// Processed image as base64 string
  pub image_data: String,
  /// Image dimensions
  pub width: u32,
  pub height: u32,
  /// Output format
  pub format: String,
}

/// Server capabilities
#[derive(Debug, Serialize, Deserialize)]
pub struct ServerCapabilities {
  pub supported_operations: Vec<String>,
  pub supported_input_formats: Vec<String>,
  pub supported_output_formats: Vec<String>,
}

/// Initialize request parameters
#[derive(Debug, Serialize, Deserialize)]
pub struct InitializeParams {
  pub client_info: Option<ClientInfo>,
}

/// Client information
#[derive(Debug, Serialize, Deserialize)]
pub struct ClientInfo {
  pub name: String,
  pub version: Option<String>,
}

/// Initialize response result
#[derive(Debug, Serialize, Deserialize)]
pub struct InitializeResult {
  pub capabilities: ServerCapabilities,
  pub server_info: Option<ServerInfo>,
}

/// Server information
#[derive(Debug, Serialize, Deserialize)]
pub struct ServerInfo {
  pub name: String,
  pub version: Option<String>,
}

impl Message {
  /// Create a new request message
  pub fn new_request(id: MessageId, method: String, params: serde_json::Value) -> Self {
    Self {
      jsonrpc: "2.0".to_string(),
      id: Some(id),
      method: Some(method),
      params: Some(params),
      result: None,
      error: None,
    }
  }

  /// Create a new response message
  pub fn new_response(id: MessageId, result: serde_json::Value) -> Self {
    Self {
      jsonrpc: "2.0".to_string(),
      id: Some(id),
      method: None,
      params: None,
      result: Some(result),
      error: None,
    }
  }

  /// Create a new error response
  pub fn new_error_response(id: Option<MessageId>, error: ResponseError) -> Self {
    Self {
      jsonrpc: "2.0".to_string(),
      id,
      method: None,
      params: None,
      result: None,
      error: Some(error),
    }
  }

  /// Create a notification (request without ID)
  pub fn new_notification(method: String, params: serde_json::Value) -> Self {
    Self {
      jsonrpc: "2.0".to_string(),
      id: None,
      method: Some(method),
      params: Some(params),
      result: None,
      error: None,
    }
  }
}

impl ResponseError {
  pub fn new(code: i32, message: String) -> Self {
    Self {
      code,
      message,
      data: None,
    }
  }

  pub fn with_data(code: i32, message: String, data: serde_json::Value) -> Self {
    Self {
      code,
      message,
      data: Some(data),
    }
  }

  pub fn parse_error() -> Self {
    Self::new(error_codes::PARSE_ERROR, "Parse error".to_string())
  }

  pub fn invalid_request() -> Self {
    Self::new(error_codes::INVALID_REQUEST, "Invalid request".to_string())
  }

  pub fn method_not_found(method: &str) -> Self {
    Self::new(
      error_codes::METHOD_NOT_FOUND,
      format!("Method not found: {}", method),
    )
  }

  pub fn invalid_params(message: String) -> Self {
    Self::new(error_codes::INVALID_PARAMS, message)
  }

  pub fn internal_error(message: String) -> Self {
    Self::new(error_codes::INTERNAL_ERROR, message)
  }
}

/// Convert OperationSpec to OperationType
impl TryFrom<&OperationSpec> for OperationType {
  type Error = String;

  fn try_from(spec: &OperationSpec) -> Result<Self, Self::Error> {
    match spec.operation.as_str() {
      "brightness" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid brightness parameter: {}", e))?;
        Ok(OperationType::Brightness(value))
      }
      "contrast" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid contrast parameter: {}", e))?;
        Ok(OperationType::Contrast(value))
      }
      "saturation" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid saturation parameter: {}", e))?;
        Ok(OperationType::Saturation(value))
      }
      "hue" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid hue parameter: {}", e))?;
        Ok(OperationType::Hue(value))
      }
      "gamma" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid gamma parameter: {}", e))?;
        Ok(OperationType::Gamma(value))
      }
      "white_balance" => {
        #[derive(Deserialize)]
        struct WhiteBalanceParams {
          auto_adjust: Option<bool>,
          temperature: Option<f32>,
          tint: Option<f32>,
        }
        let params: WhiteBalanceParams = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid white_balance parameters: {}", e))?;
        Ok(OperationType::WhiteBalance {
          auto_adjust: params.auto_adjust.unwrap_or(false),
          temperature: params.temperature,
          tint: params.tint,
        })
      }
      "blur" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid blur parameter: {}", e))?;
        Ok(OperationType::Blur(value))
      }
      "sharpen" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid sharpen parameter: {}", e))?;
        Ok(OperationType::Sharpen(value))
      }
      "noise" => {
        let value: f32 = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid noise parameter: {}", e))?;
        Ok(OperationType::Noise(value))
      }
      "resize" => {
        #[derive(serde::Deserialize)]
        struct ResizeParams {
          width: Option<u32>,
          height: Option<u32>,
        }
        let params: ResizeParams = serde_json::from_value(spec.params.clone())
          .map_err(|e| format!("Invalid resize parameters: {}", e))?;
        Ok(OperationType::Resize { width: params.width, height: params.height })
      }

      _ => Err(format!("Unknown operation: {}", spec.operation)),
    }
  }
}

/// Message transport layer for reading/writing messages with Content-Length headers
pub struct MessageTransport<R, W> {
  reader: BufReader<R>,
  writer: W,
}

impl<R: std::io::Read, W: std::io::Write> MessageTransport<R, W> {
  pub fn new(reader: R, writer: W) -> Self {
    Self {
      reader: BufReader::new(reader),
      writer,
    }
  }

  /// Read a message from the input stream
  pub fn read_message(&mut self) -> io::Result<Message> {
    // Read headers until empty line
    let mut headers = HashMap::new();
    let mut line = String::new();

    loop {
      line.clear();
      let bytes_read = self.reader.read_line(&mut line)?;
      if bytes_read == 0 {
        return Err(io::Error::new(
          io::ErrorKind::UnexpectedEof,
          "Unexpected EOF while reading headers",
        ));
      }

      let line = line.trim();
      if line.is_empty() {
        break;
      }

      if let Some((key, value)) = line.split_once(':') {
        headers.insert(key.trim().to_lowercase(), value.trim().to_string());
      }
    }

    // Get content length
    let content_length = headers
      .get("content-length")
      .ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "Missing Content-Length header")
      })?
      .parse::<usize>()
      .map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidData, "Invalid Content-Length")
      })?;

    // Read the message body
    let mut buffer = vec![0; content_length];
    self.reader.read_exact(&mut buffer)?;

    let message_str = String::from_utf8(buffer)
      .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid UTF-8"))?;

    serde_json::from_str(&message_str).map_err(|e| {
      io::Error::new(
        io::ErrorKind::InvalidData,
        format!("Failed to parse JSON: {}", e),
      )
    })
  }

  /// Write a message to the output stream
  pub fn write_message(&mut self, message: &Message) -> io::Result<()> {
    let json = serde_json::to_string(message)
      .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

    write!(
      self.writer,
      "Content-Length: {}\r\n\r\n{}",
      json.len(),
      json
    )?;
    self.writer.flush()?;
    Ok(())
  }
}

/// Async version of MessageTransport
pub struct AsyncMessageTransport<R, W> {
  reader: TokioBufReader<R>,
  writer: W,
}

impl<R: tokio::io::AsyncRead + Unpin, W: tokio::io::AsyncWrite + Unpin>
  AsyncMessageTransport<R, W>
{
  pub fn new(reader: R, writer: W) -> Self {
    Self {
      reader: TokioBufReader::new(reader),
      writer,
    }
  }

  /// Read a message from the input stream asynchronously
  pub async fn read_message(&mut self) -> io::Result<Message> {
    // Read headers until empty line
    let mut headers = HashMap::new();
    let mut line = String::new();

    loop {
      line.clear();
      let bytes_read = self.reader.read_line(&mut line).await?;
      if bytes_read == 0 {
        return Err(io::Error::new(
          io::ErrorKind::UnexpectedEof,
          "Unexpected EOF while reading headers",
        ));
      }

      let line = line.trim();
      if line.is_empty() {
        break;
      }

      if let Some((key, value)) = line.split_once(':') {
        headers.insert(key.trim().to_lowercase(), value.trim().to_string());
      }
    }

    // Get content length
    let content_length = headers
      .get("content-length")
      .ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "Missing Content-Length header")
      })?
      .parse::<usize>()
      .map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidData, "Invalid Content-Length")
      })?;

    // Read the message body
    let mut buffer = vec![0; content_length];
    use tokio::io::AsyncReadExt;
    self.reader.read_exact(&mut buffer).await?;

    let message_str = String::from_utf8(buffer)
      .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "Invalid UTF-8"))?;

    serde_json::from_str(&message_str).map_err(|e| {
      io::Error::new(
        io::ErrorKind::InvalidData,
        format!("Failed to parse JSON: {}", e),
      )
    })
  }

  /// Write a message to the output stream asynchronously
  pub async fn write_message(&mut self, message: &Message) -> io::Result<()> {
    let json = serde_json::to_string(message)
      .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

    let header = format!("Content-Length: {}\r\n\r\n", json.len());
    self.writer.write_all(header.as_bytes()).await?;
    self.writer.write_all(json.as_bytes()).await?;
    self.writer.flush().await?;
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_message_creation() {
    let msg = Message::new_request(1, "test".to_string(), serde_json::json!({}));
    assert_eq!(msg.jsonrpc, "2.0");
    assert_eq!(msg.id, Some(1));
    assert_eq!(msg.method, Some("test".to_string()));
  }

  #[test]
  fn test_operation_conversion() {
    let spec = OperationSpec {
      operation: "brightness".to_string(),
      params: serde_json::json!(1.5),
    };

    let op: OperationType = (&spec).try_into().unwrap();
    match op {
      OperationType::Brightness(value) => assert_eq!(value, 1.5),
      _ => panic!("Wrong operation type"),
    }
  }

  #[test]
  fn test_white_balance_conversion() {
    let spec = OperationSpec {
      operation: "white_balance".to_string(),
      params: serde_json::json!({
          "auto_adjust": true,
          "temperature": 5500.0,
          "tint": 0.2
      }),
    };

    let op: OperationType = (&spec).try_into().unwrap();
    match op {
      OperationType::WhiteBalance {
        auto_adjust,
        temperature,
        tint,
      } => {
        assert!(auto_adjust);
        assert_eq!(temperature, Some(5500.0));
        assert_eq!(tint, Some(0.2));
      }
      _ => panic!("Wrong operation type"),
    }
  }
}
