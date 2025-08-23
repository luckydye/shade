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
