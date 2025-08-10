# Shade Image Processor Socket Protocol

This document describes the messaging protocol for communicating with the Shade image processor when running in socket mode. The protocol is based on the Language Server Protocol (LSP) specification and uses JSON-RPC 2.0 over stdin/stdout with Content-Length headers.

## Overview

The Shade image processor can be run in socket mode using the `--socket` flag:

```bash
shade --socket
```

In this mode, the processor acts as a server that:
- Reads JSON-RPC messages from stdin
- Processes image manipulation requests
- Sends responses back through stdout
- Uses Content-Length headers for message framing (similar to LSP)

## Message Format

All messages follow the JSON-RPC 2.0 specification with Content-Length headers:

```
Content-Length: <length>\r\n
\r\n
<JSON message>
```

### Base Message Structure

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "method_name",
  "params": { ... }
}
```

For responses:
```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "result": { ... }
}
```

For errors:
```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "error": {
    "code": -32600,
    "message": "Invalid request",
    "data": { ... }
  }
}
```

## Methods

### 1. initialize

Initializes the server and returns its capabilities.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "client_info": {
      "name": "my-client",
      "version": "1.0.0"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "capabilities": {
      "supported_operations": [
        "brightness",
        "contrast",
        "saturation",
        "hue",
        "gamma",
        "white_balance",
        "blur",
        "sharpen",
        "noise",
        "scale",
        "rotate"
      ],
      "supported_input_formats": [
        "png",
        "jpg",
        "jpeg",
        "bmp",
        "tiff",
        "exr",
        "base64"
      ],
      "supported_output_formats": [
        "png",
        "jpg",
        "jpeg",
        "bmp",
        "tiff"
      ]
    },
    "server_info": {
      "name": "shade-image-processor",
      "version": "0.1.0"
    }
  }
}
```

### 2. process_image

Processes an image with specified operations.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "process_image",
  "params": {
    "image": {
      "type": "file",
      "path": "/path/to/image.jpg"
    },
    "operations": [
      {
        "operation": "brightness",
        "params": 1.2
      },
      {
        "operation": "contrast",
        "params": 1.1
      }
    ],
    "output_format": "png"
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "image_data": "iVBORw0KGgoAAAANSUhEUgAA...",
    "width": 1920,
    "height": 1080,
    "format": "png"
  }
}
```

### 3. shutdown

Gracefully shuts down the server.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "shutdown"
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": null
}
```

### 4. exit

Immediately exits the server (no response expected).

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "exit"
}
```

## Input Image Formats

The `image` parameter in `process_image` requests supports three formats:

### File Path
```json
{
  "type": "file",
  "path": "/absolute/path/to/image.jpg"
}
```

### Base64 Encoded Data
```json
{
  "type": "base64",
  "data": "iVBORw0KGgoAAAANSUhEUgAA..."
}
```

### Binary Blob (JSON array of bytes)
```json
{
  "type": "blob",
  "data": [137, 80, 78, 71, 13, 10, 26, 10, ...]
}
```

## Operations

Each operation has a specific parameter format:

### Simple Operations (single float parameter)
- `brightness`: Brightness adjustment (0.0 = black, 1.0 = normal, 2.0 = double brightness)
- `contrast`: Contrast adjustment (0.0 = gray, 1.0 = normal, 2.0 = high contrast)
- `saturation`: Saturation adjustment (0.0 = grayscale, 1.0 = normal, 2.0 = vibrant)
- `hue`: Hue rotation in degrees (-180 to 180)
- `gamma`: Gamma correction (0.5 = darker, 1.0 = normal, 2.0 = lighter)
- `blur`: Blur radius in pixels
- `sharpen`: Sharpening amount (0.0 = no effect, 1.0 = normal, 2.0 = strong)
- `noise`: Noise amount (0.0 = no noise, 1.0 = normal noise)
- `scale`: Scale factor (0.5 = half size, 1.0 = normal, 2.0 = double size)
- `rotate`: Rotation angle in degrees

**Example:**
```json
{
  "operation": "brightness",
  "params": 1.5
}
```

### White Balance (complex parameters)
```json
{
  "operation": "white_balance",
  "params": {
    "auto_adjust": false,
    "temperature": 5500.0,
    "tint": 0.1
  }
}
```

Parameters:
- `auto_adjust` (boolean): Enable automatic white balance
- `temperature` (float, optional): Color temperature in Kelvin (2000-10000)
- `tint` (float, optional): Tint adjustment (-1.0 to 1.0)

## Error Codes

The server uses standard JSON-RPC error codes:

- `-32700`: Parse error (invalid JSON)
- `-32600`: Invalid request
- `-32601`: Method not found
- `-32602`: Invalid params
- `-32603`: Internal error
- `-32002`: Server not initialized (custom)

## Example Session

```
// Client initializes server
Content-Length: 156

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client_info":{"name":"test-client","version":"1.0.0"}}}

// Server responds with capabilities
Content-Length: 423

{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"supported_operations":["brightness","contrast","saturation"],"supported_input_formats":["png","jpg"],"supported_output_formats":["png"]},"server_info":{"name":"shade-image-processor","version":"0.1.0"}}}

// Client processes an image
Content-Length: 234

{"jsonrpc":"2.0","id":2,"method":"process_image","params":{"image":{"type":"file","path":"input.jpg"},"operations":[{"operation":"brightness","params":1.2}],"output_format":"png"}}

// Server returns processed image
Content-Length: 145

{"jsonrpc":"2.0","id":2,"result":{"image_data":"iVBORw0KGgo...","width":1920,"height":1080,"format":"png"}}

// Client shuts down server
Content-Length: 56

{"jsonrpc":"2.0","id":3,"method":"shutdown"}

// Server confirms shutdown
Content-Length: 42

{"jsonrpc":"2.0","id":3,"result":null}
```

## Implementation Notes

- The server must be initialized before processing images
- All images are processed on the GPU using WGPU
- Operations are applied in the order specified in the operations array
- Base64 encoded results use standard base64 encoding without padding
- File paths should be absolute paths accessible to the server process
- The server will exit on encountering invalid JSON or I/O errors

## Client Libraries

While you can implement the protocol directly, consider using existing JSON-RPC or LSP client libraries in your preferred language, as they handle the Content-Length framing and message correlation automatically.