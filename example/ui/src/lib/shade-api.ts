import { invoke } from "@tauri-apps/api/core";

// Types matching the Rust structs
export interface ImageInput {
	type: "file" | "base64";
	path?: string;
	data?: string;
}

export interface OperationSpec {
	operation: string;
	params: unknown;
}

export interface ProcessImageRequest {
	image: ImageInput;
	operations: OperationSpec[];
	output_format?: string;
}

export interface ProcessImageResult {
	image_attachment_id: string;
	width: number;
	height: number;
	format: string;
}

export interface ShadeStatus {
	running: boolean;
	pending_requests: number;
	message_counter: number;
}

export interface ServerCapabilities {
	supported_operations: string[];
	supported_input_formats: string[];
	supported_output_formats: string[];
}

// Shade API utility functions
export const ShadeAPI = {
	/**
	 * Process an image with the specified operations
	 */
	async processImage(
		request: ProcessImageRequest,
	): Promise<ProcessImageResult> {
		return invoke("process_image", { request });
	},

	/**
	 * Get server capabilities (supported operations, formats, etc.)
	 */
	async getCapabilities(): Promise<ServerCapabilities> {
		return invoke("get_capabilities");
	},

	/**
	 * Check if the Shade process is running
	 */
	async isShadeRunning(): Promise<boolean> {
		return invoke("is_shade_running");
	},

	/**
	 * Restart the Shade process
	 */
	async restartShade(): Promise<void> {
		return invoke("restart_shade");
	},

	/**
	 * Stop the Shade process
	 */
	async stopShade(): Promise<void> {
		return invoke("stop_shade");
	},

	/**
	 * Get detailed status of the Shade process
	 */
	async getShadeStatus(): Promise<ShadeStatus> {
		return invoke("get_shade_status");
	},

	/**
	 * Get binary attachment data by ID
	 *
	 * This method retrieves binary image data from the Shade server using an attachment ID
	 * returned from image processing operations. The binary data can then be converted to
	 * a Blob and used to create object URLs for display in the UI.
	 *
	 * @param attachmentId - The unique identifier for the binary attachment
	 * @returns Promise<Uint8Array> - The raw binary data of the processed image
	 *
	 * @example
	 * ```typescript
	 * // Process image and get attachment ID
	 * const result = await ShadeAPI.processImageFile(filePath, operations, "png");
	 *
	 * // Retrieve binary data
	 * const binaryData = await ShadeAPI.getAttachment(result.image_attachment_id);
	 *
	 * // Create blob URL for preview display
	 * const blob = new Blob([binaryData], { type: `image/${result.format}` });
	 * const blobUrl = URL.createObjectURL(blob);
	 *
	 * // Remember to clean up the blob URL when done
	 * URL.revokeObjectURL(blobUrl);
	 * ```
	 */
	async getAttachment(attachmentId: string): Promise<Uint8Array> {
		return invoke("get_attachment", { attachmentId });
	},

	/**
	 * Read image file as raw bytes and create blob URL
	 *
	 * This method reads an image file from the local filesystem as raw bytes and creates
	 * a blob URL for display. This is useful for files with problematic paths (spaces,
	 * special characters) that don't work well with convertFileSrc or file:// URLs.
	 *
	 * @param filePath - Full path to the image file
	 * @returns Promise<string> - Blob URL that can be used in img elements
	 *
	 * @example
	 * ```typescript
	 * // Read image with spaces in filename
	 * const blobUrl = await ShadeAPI.readImageAsBlob("/path/to/my image.jpg");
	 *
	 * // Use in img element
	 * imageElement.src = blobUrl;
	 *
	 * // Remember to clean up when done
	 * URL.revokeObjectURL(blobUrl);
	 * ```
	 */
	async readImageAsBlob(filePath: string): Promise<string> {
		// Get raw bytes from Tauri command
		const binaryData = await invoke<number[]>("read_image_as_bytes", {
			filePath,
		});

		// Convert number array to Uint8Array
		const uint8Array = new Uint8Array(binaryData);

		// Determine MIME type from file extension
		const extension = filePath.split(".").pop()?.toLowerCase();
		const mimeType =
			extension === "jpeg" || extension === "jpg"
				? "image/jpeg"
				: extension === "png"
					? "image/png"
					: extension === "gif"
						? "image/gif"
						: extension === "webp"
							? "image/webp"
							: extension === "bmp"
								? "image/bmp"
								: extension === "tiff" || extension === "tif"
									? "image/tiff"
									: "image/jpeg"; // Default fallback

		// Create blob and return object URL
		const blob = new Blob([uint8Array], { type: mimeType });
		return URL.createObjectURL(blob);
	},

	/**
	 * Convenience method to process an image from a file path
	 */
	async processImageFile(
		filePath: string,
		operations: OperationSpec[],
		outputFormat: string = "png",
	): Promise<ProcessImageResult> {
		const request: ProcessImageRequest = {
			image: { type: "file", path: filePath },
			operations,
			output_format: outputFormat,
		};
		return ShadeAPI.processImage(request);
	},

	/**
	 * Convenience method to process an image from base64 data
	 */
	async processImageBase64(
		base64Data: string,
		operations: OperationSpec[],
		outputFormat: string = "png",
	): Promise<ProcessImageResult> {
		const request: ProcessImageRequest = {
			image: { type: "base64", data: base64Data },
			operations,
			output_format: outputFormat,
		};
		return ShadeAPI.processImage(request);
	},

	/**
	 * Helper to create common operations
	 */
	operations: {
		brightness: (value: number): OperationSpec => ({
			operation: "brightness",
			params: value,
		}),

		contrast: (value: number): OperationSpec => ({
			operation: "contrast",
			params: value,
		}),

		saturation: (value: number): OperationSpec => ({
			operation: "saturation",
			params: value,
		}),

		hue: (value: number): OperationSpec => ({
			operation: "hue",
			params: value,
		}),

		gamma: (value: number): OperationSpec => ({
			operation: "gamma",
			params: value,
		}),

		whiteBalance: (options: {
			auto_adjust?: boolean;
			temperature?: number;
			tint?: number;
		}): OperationSpec => ({
			operation: "white_balance",
			params: options,
		}),

		blur: (value: number): OperationSpec => ({
			operation: "blur",
			params: value,
		}),

		sharpen: (value: number): OperationSpec => ({
			operation: "sharpen",
			params: value,
		}),

		noise: (value: number): OperationSpec => ({
			operation: "noise",
			params: value,
		}),

		resize: (options: { width?: number; height?: number }): OperationSpec => ({
			operation: "resize",
			params: options,
		}),
	},
};

// Usage examples:
/*
// Basic usage:
const result = await ShadeAPI.processImageFile(
  '/path/to/image.jpg',
  [
    ShadeAPI.operations.brightness(1.2),
    ShadeAPI.operations.contrast(1.1),
  ],
  'png'
);

// Check status:
const isRunning = await ShadeAPI.isShadeRunning();
const status = await ShadeAPI.getShadeStatus();

// Get capabilities:
const capabilities = await ShadeAPI.getCapabilities();
console.log('Supported operations:', capabilities.supported_operations);

// Process with multiple operations:
const complexResult = await ShadeAPI.processImageFile(
  '/path/to/raw-image.cr3',
  [
    ShadeAPI.operations.whiteBalance({ auto_adjust: true }),
    ShadeAPI.operations.brightness(1.1),
    ShadeAPI.operations.contrast(1.05),
    ShadeAPI.operations.saturation(1.1),
    ShadeAPI.operations.resize({ width: 1920, height: 1080 }),
    ShadeAPI.operations.sharpen(0.5),
  ],
  'jpg'
);
*/
