#!/usr/bin/env python3
"""
Example client for the Shade Image Processor Socket Protocol.

This demonstrates how to communicate with the shade image processor
when running in socket mode using the JSON-RPC protocol.
"""

import json
import subprocess
import sys
import base64
import os
from typing import Optional, Dict, Any, List
import time


class ShadeClient:
    """Client for communicating with the Shade image processor."""

    def __init__(self):
        self.process = None
        self.next_id = 1

    def start_server(self, shade_binary_path: str = "shade"):
        """Start the shade server process."""
        try:
            self.process = subprocess.Popen(
                [shade_binary_path, "--socket"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=False  # We need binary mode for proper message handling
            )
            print(f"Started shade server with PID: {self.process.pid}")
        except FileNotFoundError:
            raise RuntimeError(f"Shade binary not found at: {shade_binary_path}")

    def stop_server(self):
        """Stop the shade server process."""
        if self.process:
            try:
                self.send_request("shutdown")
            except Exception as e:
                print(f"Failed to send shutdown: {e}")
            try:
                self.process.wait(timeout=5)
            except Exception as e:
                print(f"Process didn't shutdown gracefully: {e}")
                self.process.terminate()
            self.process = None

    def send_message(self, message: Dict[str, Any]):
        """Send a message to the server."""
        if not self.process:
            raise RuntimeError("Server not started")

        json_str = json.dumps(message)
        message_bytes = json_str.encode('utf-8')
        header = f"Content-Length: {len(message_bytes)}\r\n\r\n"

        full_message = header.encode('utf-8') + message_bytes
        self.process.stdin.write(full_message)
        self.process.stdin.flush()

    def read_message(self) -> Dict[str, Any]:
        """Read a message from the server."""
        if not self.process:
            raise RuntimeError("Server not started")

        # Read headers
        headers = {}
        while True:
            line = self.process.stdout.readline().decode('utf-8').strip()

            if not line:
                break
            if ':' in line:
                key, value = line.split(':', 1)
                headers[key.strip().lower()] = value.strip()



        # Get content length
        content_length = int(headers.get('content-length', 0))
        if content_length == 0:
            raise RuntimeError("Missing or invalid Content-Length header")

        # Read message body
        message_bytes = self.process.stdout.read(content_length)
        message_str = message_bytes.decode('utf-8')



        return json.loads(message_str)

    def send_request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Send a request and wait for response."""
        message = {
            "jsonrpc": "2.0",
            "id": self.next_id,
            "method": method
        }
        if params:
            message["params"] = params

        request_id = self.next_id
        self.next_id += 1

        self.send_message(message)

        # Wait for response
        try:
            response = self.read_message()
        except Exception as e:
            print(f"Failed to read response: {e}")
            raise



        if response.get("id") != request_id:
            raise RuntimeError(f"Response ID mismatch: expected {request_id}, got {response.get('id')}")

        if "error" in response and response["error"] is not None:
            error = response["error"]
            raise RuntimeError(f"Server error {error['code']}: {error['message']}")

        return response.get("result", {})

    def initialize(self) -> Dict[str, Any]:
        """Initialize the server."""
        return self.send_request("initialize", {
            "client_info": {
                "name": "python-example-client",
                "version": "1.0.0"
            }
        })

    def process_image_file(self,
                          input_path: str,
                          operations: List[Dict[str, Any]],
                          output_format: str = "png") -> Dict[str, Any]:
        """Process an image from a file path."""
        return self.send_request("process_image", {
            "image": {
                "type": "file",
                "path": input_path
            },
            "operations": operations,
            "output_format": output_format
        })

    def process_image_base64(self,
                            base64_data: str,
                            operations: List[Dict[str, Any]],
                            output_format: str = "png") -> Dict[str, Any]:
        """Process an image from base64 data."""
        return self.send_request("process_image", {
            "image": {
                "type": "base64",
                "data": base64_data
            },
            "operations": operations,
            "output_format": output_format
        })


def load_image_as_base64(image_path: str) -> str:
    """Load an image file and encode it as base64."""
    with open(image_path, 'rb') as f:
        image_data = f.read()
    return base64.b64encode(image_data).decode('utf-8')


def save_base64_image(base64_data: str, output_path: str):
    """Save base64 encoded image data to a file."""
    image_data = base64.b64decode(base64_data)
    with open(output_path, 'wb') as f:
        f.write(image_data)


def main():
    """Example usage of the Shade client."""
    if len(sys.argv) < 2:
        print("Usage: python example_client.py <input_image_path> [shade_binary_path]")
        print("Example: python example_client.py input.jpg ../target/release/shade")
        sys.exit(1)

    input_image = sys.argv[1]
    shade_binary = sys.argv[2] if len(sys.argv) > 2 else "shade"

    if not os.path.exists(input_image):
        print(f"Input image not found: {input_image}")
        sys.exit(1)

    client = ShadeClient()

    try:
        # Start the server
        print("Starting Shade server...")
        client.start_server(shade_binary)

        # Give the server a moment to start
        time.sleep(0.5)

        # Initialize
        print("Initializing server...")
        init_result = client.initialize()
        print("Server capabilities:", init_result["capabilities"]["supported_operations"])

        # Example 1: Process image from file path
        print(f"\nProcessing image from file: {input_image}")
        operations = [
            {"operation": "brightness", "params": 1.2},
            {"operation": "contrast", "params": 1.1},
            {"operation": "saturation", "params": 1.3}
        ]

        result = client.process_image_file(
            input_path=os.path.abspath(input_image),
            operations=operations,
            output_format="png"
        )

        print(f"Processed image dimensions: {result['width']}x{result['height']}")

        # Save the result
        output_path = "output_from_file.png"
        save_base64_image(result["image_data"], output_path)
        print(f"Saved processed image to: {output_path}")

        # Example 2: Process image from base64 data
        print(f"\nProcessing image from base64 data...")
        base64_data = load_image_as_base64(input_image)

        # Different operations for the second example
        operations2 = [
            {"operation": "hue", "params": 30.0},  # Rotate hue by 30 degrees
            {"operation": "gamma", "params": 1.2},
            {
                "operation": "white_balance",
                "params": {
                    "auto_adjust": False,
                    "temperature": 5500.0,
                    "tint": 0.1
                }
            }
        ]

        result2 = client.process_image_base64(
            base64_data=base64_data,
            operations=operations2,
            output_format="jpg"
        )

        # Save the second result
        output_path2 = "output_from_base64.jpg"
        save_base64_image(result2["image_data"], output_path2)
        print(f"Saved second processed image to: {output_path2}")

        # Example 3: Chain multiple simple operations
        print(f"\nApplying multiple operations in sequence...")
        operations3 = [
            {"operation": "brightness", "params": 0.8},   # Darker
            {"operation": "contrast", "params": 1.4},     # More contrast
            {"operation": "blur", "params": 1.0},         # Slight blur
            {"operation": "sharpen", "params": 0.8},      # Then sharpen
            {"operation": "noise", "params": 0.1}         # Add slight noise
        ]

        result3 = client.process_image_file(
            input_path=os.path.abspath(input_image),
            operations=operations3,
            output_format="png"
        )

        output_path3 = "output_multi_ops.png"
        save_base64_image(result3["image_data"], output_path3)
        print(f"Saved multi-operation result to: {output_path3}")

    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

    finally:
        # Clean shutdown
        print("\nShutting down server...")
        client.stop_server()
        print("Done!")


if __name__ == "__main__":
    main()
