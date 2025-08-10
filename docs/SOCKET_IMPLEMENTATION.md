# Shade Socket Mode Implementation Summary

This document summarizes the socket-based operation mode that was added to the Shade image processor, allowing it to function as a language server-style service for integration with other applications.

## Overview

The implementation adds a `--socket` flag to the Shade binary that enables JSON-RPC 2.0 communication over stdin/stdout, similar to Language Server Protocol (LSP). This allows other applications to programmatically control image processing operations without spawning separate processes for each operation.

## Architecture

### Core Components

1. **Socket Module** (`src/socket.rs`)
   - Message structures following JSON-RPC 2.0 specification
   - Transport layer handling Content-Length headers
   - Operation parameter serialization/deserialization
   - Both sync and async transport implementations

2. **Server Module** (`src/server.rs`)
   - `ImageProcessingServer` struct managing the server lifecycle
   - Message routing and request handling
   - Image loading from various sources (file, base64, blob)
   - GPU pipeline initialization and processing
   - Response generation and error handling

3. **Protocol Integration** (`src/main.rs`)
   - Command-line flag detection for socket mode
   - Server initialization and startup

### Message Flow

```
Client -> stdin -> Server -> GPU Processing -> stdout -> Client
```

1. Client sends JSON-RPC request with Content-Length header
2. Server reads and parses message
3. Server processes image operations on GPU
4. Server encodes result as base64
5. Server sends JSON-RPC response back to client

## Supported Methods

### 1. initialize
- **Purpose**: Initialize server and return capabilities
- **Parameters**: Client information (optional)
- **Response**: Server capabilities and supported operations/formats

### 2. process_image
- **Purpose**: Process image with specified operations
- **Parameters**: Image input, operations array, output format
- **Response**: Processed image as base64, dimensions, format

### 3. shutdown
- **Purpose**: Gracefully shutdown server
- **Parameters**: None
- **Response**: Null result, then server exits

### 4. exit
- **Purpose**: Immediately exit server
- **Parameters**: None
- **Response**: No response (server exits immediately)

## Image Input Formats

1. **File Path**: Absolute path to image file
2. **Base64**: Image data encoded as base64 string
3. **Blob**: Raw image bytes as JSON array

## Operation Parameters

All image operations from CLI mode are supported:
- Simple operations: brightness, contrast, saturation, hue, gamma, blur, sharpen, noise, scale, rotate
- Complex operations: white_balance (with auto_adjust, temperature, tint parameters)

## Error Handling

- Standard JSON-RPC 2.0 error codes
- Custom error code -32002 for "Server not initialized"
- Detailed error messages with parameter validation
- Graceful handling of GPU initialization failures

## Key Implementation Details

### Message Transport
- Uses Content-Length headers for message framing (LSP-style)
- Handles both synchronous and asynchronous I/O
- Proper UTF-8 encoding/decoding
- JSON serialization with optional field skipping

### Image Processing Pipeline
- Reuses existing GPU pipeline from CLI mode
- Converts between different precision formats (8-bit, 16-bit, 32-bit float)
- Handles format-specific encoding (JPEG RGB vs PNG RGBA)
- Memory-efficient processing for large images

### GPU Resource Management
- One-time GPU initialization per server session
- Shared device and queue across all operations
- Proper resource cleanup on shutdown

## Client Integration

### Python Client (`example_client.py`)
- Complete working example with error handling
- Support for all input formats and operations
- Proper process lifecycle management
- Base64 encoding/decoding utilities

### Protocol Compatibility
- Compatible with existing JSON-RPC 2.0 clients
- Can be used with LSP client libraries
- Standard Content-Length framing

## Performance Characteristics

- **GPU Initialization**: One-time cost when server starts
- **Operation Processing**: GPU-accelerated, scales with image size
- **Memory Usage**: Efficient streaming for base64 data
- **Throughput**: Single-threaded request processing (one at a time)

## Testing and Validation

- Full end-to-end test with Python client
- Multiple image formats (PNG, JPEG, HDR)
- All operation types validated
- Error conditions tested
- Graceful shutdown verified

## Files Added/Modified

### New Files
- `src/socket.rs` - Protocol and message structures
- `src/server.rs` - Server implementation
- `example_client.py` - Python client example
- `SOCKET_PROTOCOL.md` - Complete protocol documentation
- `README_SOCKET.md` - User documentation
- `test_socket.sh` - Basic shell test script

### Modified Files
- `src/main.rs` - Added socket mode detection and startup
- `Cargo.toml` - Added dependencies (serde, tokio, base64)

## Dependencies Added

```toml
base64 = "0.22"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1.0", features = ["io-util", "io-std", "rt", "macros"] }
```

## Usage Examples

### Basic Usage
```bash
# Start server
shade --socket

# Use with Python client
python3 example_client.py input.jpg ./target/release/shade
```

### Integration Example
```python
client = ShadeClient()
client.start_server("shade")
result = client.process_image_file(
    "input.jpg", 
    [{"operation": "brightness", "params": 1.2}]
)
```

## Future Enhancements

Potential improvements that could be added:
- Async processing for concurrent requests
- Streaming for very large images
- Additional output formats
- Pipeline caching and reuse
- WebSocket transport option
- Authentication/authorization

## Conclusion

The socket mode implementation successfully transforms Shade from a CLI-only tool into a programmable service that can be integrated into larger applications. The JSON-RPC 2.0 protocol ensures compatibility with existing tooling, while the GPU acceleration provides high-performance image processing capabilities.