import type React from "react";
import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ShadeStatus, OperationSpec } from "../lib/shade-api";
import { ShadeAPI } from "../lib/shade-api";

interface ImageProcessorProps {
	className?: string;
}

interface HistogramData {
	red: number[];
	green: number[];
	blue: number[];
	luminance: number[];
}

interface ImageData {
	src: string;
	width: number;
	height: number;
	name: string;
}

interface PreviewState {
	original: ImageData | null;
	processed: ImageData | null;
	isProcessing: boolean;
}

const ImageProcessor: React.FC<ImageProcessorProps> = () => {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [previewState, setPreviewState] = useState<PreviewState>({
		original: null,
		processed: null,
		isProcessing: false,
	});
	const [error, setError] = useState<string | null>(null);
	const [shadeStatus, setShadeStatus] = useState<ShadeStatus | null>(null);
	const [operations, setOperations] = useState<OperationSpec[]>([]);
	const [showBeforeAfter, setShowBeforeAfter] = useState(false);
	const [activePanel, setActivePanel] = useState<
		"basic" | "tone" | "color" | "effects" | "histogram"
	>("basic");
	const [histogram, setHistogram] = useState<HistogramData | null>(null);

	// Image adjustment controls
	const [adjustments, setAdjustments] = useState({
		// Basic adjustments
		exposure: 0.0,
		highlights: 0.0,
		shadows: 0.0,
		whites: 0.0,
		blacks: 0.0,

		// Tone curve
		brightness: 1.0,
		contrast: 1.0,
		gamma: 1.0,

		// Color adjustments
		saturation: 1.0,
		vibrance: 0.0,
		hue: 0.0,
		temperature: 0.0,
		tint: 0.0,

		// Effects
		clarity: 0.0,
		dehaze: 0.0,
		blur: 0.0,
		sharpen: 0.0,
		noise: 0.0,
	});

	const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Fallback histogram generator
	const generateFallbackHistogram = useCallback((): HistogramData => {
		const bins = 256;
		const red = Array.from(
			{ length: bins },
			(_, i) => Math.random() * Math.exp((i - 128) ** 2 / 5000),
		);
		const green = Array.from(
			{ length: bins },
			(_, i) => Math.random() * Math.exp((i - 100) ** 2 / 4000),
		);
		const blue = Array.from(
			{ length: bins },
			(_, i) => Math.random() * Math.exp((i - 150) ** 2 / 6000),
		);
		const luminance = red.map((r, i) => (r + green[i] + blue[i]) / 3);

		return { red, green, blue, luminance };
	}, []);

	/**
	 * Generate histogram data from actual image pixels using Canvas API
	 * Analyzes RGB channels and calculates luminance distribution
	 * Falls back to dummy data if canvas operations fail
	 */
	const generateHistogram = useCallback(
		(imageSrc: string): Promise<HistogramData> => {
			return new Promise((resolve) => {
				const img = new Image();
				img.crossOrigin = "anonymous";

				img.onload = () => {
					try {
						// Create canvas to analyze pixel data
						const canvas = document.createElement("canvas");
						const ctx = canvas.getContext("2d");
						if (!ctx) {
							resolve(generateFallbackHistogram());
							return;
						}

						canvas.width = img.width;
						canvas.height = img.height;
						ctx.drawImage(img, 0, 0);

						const imageData = ctx.getImageData(
							0,
							0,
							canvas.width,
							canvas.height,
						);
						const data = imageData.data;

						// Initialize histogram bins (256 values for each channel)
						const red = new Array(256).fill(0);
						const green = new Array(256).fill(0);
						const blue = new Array(256).fill(0);
						const luminance = new Array(256).fill(0);

						// Analyze pixels
						for (let i = 0; i < data.length; i += 4) {
							const r = data[i];
							const g = data[i + 1];
							const b = data[i + 2];
							// Alpha is data[i + 3], but we'll ignore it for histogram

							red[r]++;
							green[g]++;
							blue[b]++;

							// Calculate luminance using standard weights
							const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
							luminance[lum]++;
						}

						// Normalize values to get relative frequencies
						const totalPixels = canvas.width * canvas.height;
						const normalizeArray = (arr: number[]) =>
							arr.map((count) => count / totalPixels);

						resolve({
							red: normalizeArray(red),
							green: normalizeArray(green),
							blue: normalizeArray(blue),
							luminance: normalizeArray(luminance),
						});
					} catch (error) {
						console.warn("Failed to generate histogram from pixels:", error);
						resolve(generateFallbackHistogram());
					}
				};

				img.onerror = () => resolve(generateFallbackHistogram());
				img.src = imageSrc;
			});
		},
		[generateFallbackHistogram],
	);

	/**
	 * Convert UI adjustment values to Shade operations
	 * Maps slider values to appropriate operation parameters
	 */
	useEffect(() => {
		const newOperations: OperationSpec[] = [];

		// Supported operations - map to available Shade operations
		// Combine exposure and brightness into a single brightness operation
		const combinedBrightness =
			(1.0 + adjustments.exposure) * adjustments.brightness;
		if (combinedBrightness !== 1.0) {
			newOperations.push(ShadeAPI.operations.brightness(combinedBrightness));
		}
		if (adjustments.contrast !== 1.0) {
			newOperations.push(ShadeAPI.operations.contrast(adjustments.contrast));
		}
		if (adjustments.saturation !== 1.0) {
			newOperations.push(
				ShadeAPI.operations.saturation(adjustments.saturation),
			);
		}
		if (adjustments.hue !== 0.0) {
			newOperations.push(ShadeAPI.operations.hue(adjustments.hue));
		}
		if (adjustments.gamma !== 1.0) {
			newOperations.push(ShadeAPI.operations.gamma(adjustments.gamma));
		}
		if (adjustments.temperature !== 0.0 || adjustments.tint !== 0.0) {
			newOperations.push(
				ShadeAPI.operations.whiteBalance({
					temperature: 5500 + adjustments.temperature * 2000,
					tint: adjustments.tint,
				}),
			);
		}
		if (adjustments.blur > 0.0) {
			newOperations.push(ShadeAPI.operations.blur(adjustments.blur));
		}
		if (adjustments.sharpen > 0.0) {
			newOperations.push(ShadeAPI.operations.sharpen(adjustments.sharpen));
		}
		if (adjustments.noise > 0.0) {
			newOperations.push(ShadeAPI.operations.noise(adjustments.noise));
		}

		// Log unsupported adjustments for debugging
		const unsupportedAdjustments = [];
		if (adjustments.highlights !== 0.0)
			unsupportedAdjustments.push("highlights");
		if (adjustments.shadows !== 0.0) unsupportedAdjustments.push("shadows");
		if (adjustments.whites !== 0.0) unsupportedAdjustments.push("whites");
		if (adjustments.blacks !== 0.0) unsupportedAdjustments.push("blacks");
		if (adjustments.vibrance !== 0.0) unsupportedAdjustments.push("vibrance");
		if (adjustments.clarity !== 0.0) unsupportedAdjustments.push("clarity");
		if (adjustments.dehaze !== 0.0) unsupportedAdjustments.push("dehaze");

		if (unsupportedAdjustments.length > 0) {
			console.warn(
				"Unsupported adjustments ignored:",
				unsupportedAdjustments.join(", "),
			);
		}

		// Debug logging for operations
		if (newOperations.length > 0) {
			console.log(
				"Operations created:",
				newOperations.map(
					(op) => `${op.operation}: ${JSON.stringify(op.params)}`,
				),
			);
		}

		setOperations(newOperations);
	}, [adjustments]);

	/**
	 * Live preview system with debouncing
	 *
	 * This effect handles the core preview functionality:
	 * 1. Debounces adjustment changes (300ms delay)
	 * 2. Sends processing request to Shade server
	 * 3. Retrieves binary attachment containing processed image
	 * 4. Creates blob URL for display in UI
	 * 5. Generates histogram from processed image pixels
	 * 6. Cleans up blob URLs to prevent memory leaks
	 */
	useEffect(() => {
		if (!selectedFile || operations.length === 0) {
			// Reset to original image if no operations
			setPreviewState((prev) => ({
				...prev,
				processed: prev.original,
				isProcessing: false,
			}));
			return;
		}

		if (previewTimeoutRef.current) {
			clearTimeout(previewTimeoutRef.current);
		}

		previewTimeoutRef.current = setTimeout(async () => {
			console.log("Starting image processing with operations:", operations);
			setPreviewState((prev) => ({ ...prev, isProcessing: true }));

			try {
				const result = await ShadeAPI.processImageFile(
					selectedFile,
					operations,
					"png",
				);
				console.log(
					"Image processing completed, attachment ID:",
					result.image_attachment_id,
				);

				/**
				 * Binary Attachment Processing:
				 * 1. Use attachment ID to fetch binary data from Shade server
				 * 2. Convert binary data to Blob with correct MIME type
				 * 3. Create object URL for display in img elements
				 * 4. Store URL for cleanup later
				 */
				const binaryData = await ShadeAPI.getAttachment(
					result.image_attachment_id,
				);

				console.log("Data", binaryData);

				const blob = new Blob([binaryData], { type: `image/${result.format}` });
				const blobUrl = URL.createObjectURL(blob);

				setPreviewState((prev) => ({
					...prev,
					processed: prev.original
						? {
								...prev.original,
								src: blobUrl,
								width: result.width,
								height: result.height,
								name: `processed_${prev.original.name}`,
							}
						: null,
					isProcessing: false,
				}));

				// Generate real histogram from processed image pixels
				generateHistogram(blobUrl).then(setHistogram);
			} catch (err) {
				console.error("Preview processing failed:", err);
				setError(`Preview failed: ${err}`);
				setPreviewState((prev) => ({ ...prev, isProcessing: false }));
			}
		}, 300);

		// Cleanup blob URLs when component unmounts or dependencies change
		return () => {
			if (previewTimeoutRef.current) {
				clearTimeout(previewTimeoutRef.current);
			}
		};
	}, [selectedFile, operations, generateHistogram]);

	/**
	 * Memory Management: Clean up blob URLs to prevent memory leaks
	 * Blob URLs must be explicitly revoked when no longer needed
	 */
	useEffect(() => {
		return () => {
			// Clean up all blob URLs when component unmounts or state changes
			if (previewState.processed?.src?.startsWith("blob:")) {
				URL.revokeObjectURL(previewState.processed.src);
			}
			if (previewState.original?.src?.startsWith("blob:")) {
				URL.revokeObjectURL(previewState.original.src);
			}
		};
	}, [previewState.processed, previewState.original]);

	// Helper function to try multiple image loading methods
	const tryLoadImage = useCallback(
		async (filePath: string): Promise<ImageData> => {
			const fileName = filePath.split("/").pop() || "Unknown";

			// Method 1: Try Tauri's convertFileSrc first (recommended)
			try {
				const tauriSrc = convertFileSrc(filePath);
				console.log("Trying Tauri convertFileSrc:", tauriSrc);

				const imageData = await new Promise<ImageData>((resolve, reject) => {
					const img = new Image();
					img.onload = () => {
						console.log("✓ Successfully loaded with Tauri convertFileSrc");
						resolve({
							src: tauriSrc,
							width: img.naturalWidth,
							height: img.naturalHeight,
							name: fileName,
						});
					};
					img.onerror = (error) => {
						console.warn("✗ Tauri convertFileSrc failed:", error);
						reject(new Error("Tauri method failed"));
					};
					img.src = tauriSrc;
				});

				return imageData;
			} catch (error) {
				console.log(
					"Tauri convertFileSrc failed, trying file reading approach...",
				);
			}

			// Method 2: Use custom Tauri command to read file as raw bytes and create blob
			try {
				console.log("Reading file as raw bytes with Tauri command:", filePath);

				// Use our custom Tauri command to read the file as bytes and create blob URL
				const blobUrl = await ShadeAPI.readImageAsBlob(filePath);

				console.log("✓ File read as binary data, blob URL created");

				const imageData = await new Promise<ImageData>((resolve, reject) => {
					const img = new Image();
					img.onload = () => {
						console.log("✓ Successfully loaded with blob URL from binary data");
						resolve({
							src: blobUrl,
							width: img.naturalWidth,
							height: img.naturalHeight,
							name: fileName,
						});
					};
					img.onerror = (error) => {
						console.warn("✗ Blob URL from binary data failed:", error);
						URL.revokeObjectURL(blobUrl); // Clean up on error
						reject(new Error("Binary blob method failed"));
					};
					img.src = blobUrl;
				});

				return imageData;
			} catch (error) {
				console.log("Binary blob method failed:", error);
			}

			// Method 3: Try various URL encoding approaches as fallback
			const encodedPath = encodeURI(filePath);
			const encodedPathComponents = filePath
				.split("/")
				.map(encodeURIComponent)
				.join("/");

			const urlsToTry = [
				`file://${encodedPath}`,
				`file://${encodedPathComponents}`,
				`file://localhost${encodedPath}`,
				`file://localhost${encodedPathComponents}`,
				`file://${filePath.replace(/\s+/g, "%20")}`,
			];

			console.log("Trying alternative URL formats:", urlsToTry);

			for (let i = 0; i < urlsToTry.length; i++) {
				const srcUrl = urlsToTry[i];
				try {
					const imageData = await new Promise<ImageData>((resolve, reject) => {
						const img = new Image();
						img.onload = () => {
							console.log(
								`✓ Successfully loaded with URL method ${i + 1}:`,
								srcUrl,
							);
							resolve({
								src: srcUrl,
								width: img.naturalWidth,
								height: img.naturalHeight,
								name: fileName,
							});
						};
						img.onerror = (error) => {
							console.warn(`✗ URL method ${i + 1} failed:`, srcUrl, error);
							reject(new Error(`Failed to load: ${srcUrl}`));
						};
						img.src = srcUrl;
					});

					return imageData;
				} catch (error) {
					// Continue to next method
				}
			}

			throw new Error(`All loading methods failed for: ${filePath}`);
		},
		[],
	);

	const selectFile = useCallback(async () => {
		try {
			const selected = await open({
				multiple: false,
				filters: [
					{
						name: "Images",
						extensions: [
							"jpg",
							"jpeg",
							"png",
							"tiff",
							"tif",
							"bmp",
							"webp",
							"cr3",
							"arw",
							"nef",
							"dng",
							"raw",
						],
					},
				],
			});

			if (selected && typeof selected === "string") {
				setSelectedFile(selected);
				setError(null);

				try {
					// Use the improved image loading method
					const imageData = await tryLoadImage(selected);

					setPreviewState({
						original: imageData,
						processed: null,
						isProcessing: false,
					});

					// Generate histogram for original image
					try {
						const histogramData = await generateHistogram(imageData.src);
						setHistogram(histogramData);
					} catch (err) {
						console.warn(
							"Failed to generate histogram for original image:",
							err,
						);
					}
				} catch (error) {
					console.error("All image loading methods failed:", error);
					setError(
						`Unable to load image "${selected.split("/").pop()}". Please check file permissions, format support, or try a different image.`,
					);

					// Set a minimal state so UI doesn't break
					setPreviewState({
						original: {
							src: "",
							width: 0,
							height: 0,
							name: selected.split("/").pop() || "Unknown",
						},
						processed: null,
						isProcessing: false,
					});
				}
			}
		} catch (err) {
			setError(`Failed to select file: ${err}`);
		}
	}, [generateHistogram, tryLoadImage]);

	/**
	 * Load test image for debugging - creates a simple colored canvas
	 * Useful for testing the preview and histogram functionality
	 */
	const loadTestImage = useCallback(() => {
		try {
			// Create a test canvas with gradient colors
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				setError("Canvas not supported");
				return;
			}

			canvas.width = 400;
			canvas.height = 300;

			// Create a gradient background
			const gradient = ctx.createLinearGradient(
				0,
				0,
				canvas.width,
				canvas.height,
			);
			gradient.addColorStop(0, "#ff6b6b");
			gradient.addColorStop(0.33, "#4ecdc4");
			gradient.addColorStop(0.66, "#45b7d1");
			gradient.addColorStop(1, "#96ceb4");

			ctx.fillStyle = gradient;
			ctx.fillRect(0, 0, canvas.width, canvas.height);

			// Add some geometric shapes for testing
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(50, 50, 100, 100);

			ctx.fillStyle = "#000000";
			ctx.beginPath();
			ctx.arc(300, 150, 50, 0, 2 * Math.PI);
			ctx.fill();

			// Convert canvas to blob URL
			canvas.toBlob((blob) => {
				if (!blob) {
					setError("Failed to create test image");
					return;
				}

				const blobUrl = URL.createObjectURL(blob);
				const testImageData: ImageData = {
					src: blobUrl,
					width: canvas.width,
					height: canvas.height,
					name: "test_image.png",
				};

				setPreviewState({
					original: testImageData,
					processed: null,
					isProcessing: false,
				});

				// Generate histogram for test image
				generateHistogram(blobUrl)
					.then(setHistogram)
					.catch((err) =>
						console.warn("Failed to generate test histogram:", err),
					);

				setSelectedFile("test://image"); // Dummy file path
				setError(null);
			}, "image/png");
		} catch (err) {
			setError(`Failed to create test image: ${err}`);
		}
	}, [generateHistogram]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Cmd/Ctrl + I to import image
			if ((event.metaKey || event.ctrlKey) && event.key === "i") {
				event.preventDefault();
				selectFile();
			}
			// B key for before/after toggle
			if (event.key === "b" && !event.metaKey && !event.ctrlKey) {
				if (previewState.original) {
					setShowBeforeAfter(!showBeforeAfter);
				}
			}
			// Number keys for panel switching
			if (!event.metaKey && !event.ctrlKey && !event.altKey) {
				switch (event.key) {
					case "1":
						setActivePanel("basic");
						break;
					case "2":
						setActivePanel("tone");
						break;
					case "3":
						setActivePanel("color");
						break;
					case "4":
						setActivePanel("effects");
						break;
					case "5":
						setActivePanel("histogram");
						break;
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [selectFile, showBeforeAfter, previewState.original]);

	// Check Shade status
	useEffect(() => {
		const checkStatus = async () => {
			try {
				const status = await ShadeAPI.getShadeStatus();
				setShadeStatus(status);
			} catch (err) {
				console.error("Failed to get Shade status:", err);
			}
		};

		checkStatus();
		const interval = setInterval(checkStatus, 5000);
		return () => clearInterval(interval);
	}, []);

	const updateAdjustment = useCallback(
		(key: keyof typeof adjustments, value: number) => {
			setAdjustments((prev) => ({ ...prev, [key]: value }));
		},
		[],
	);

	const Slider = ({
		label,
		value,
		min,
		max,
		step = 0.01,
		onChange,
		unit = "",
	}: {
		label: string;
		value: number;
		min: number;
		max: number;
		step?: number;
		onChange: (value: number) => void;
		unit?: string;
	}) => (
		<div className="mb-4">
			<div className="flex justify-between items-center mb-2">
				<label className="text-sm font-medium text-gray-200">{label}</label>
				<span className="text-sm text-gray-400 w-16 text-right">
					{value.toFixed(2)}
					{unit}
				</span>
			</div>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(parseFloat(e.target.value))}
				className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer slider"
			/>
		</div>
	);

	const PanelButton = ({
		id,
		label,
		icon,
		shortcut,
	}: {
		id: typeof activePanel;
		label: string;
		icon: string;
		shortcut?: string;
	}) => (
		<button
			type="button"
			onClick={() => setActivePanel(id)}
			className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors relative group ${
				activePanel === id
					? "bg-blue-600 text-white"
					: "bg-gray-700 text-gray-300 hover:bg-gray-600"
			}`}
			data-tooltip={shortcut ? `Press ${shortcut}` : undefined}
		>
			<span className="mr-2">{icon}</span>
			{label}
			{shortcut && (
				<span className="absolute top-1 right-1 text-xs opacity-50 group-hover:opacity-100 transition-opacity">
					{shortcut}
				</span>
			)}
		</button>
	);

	const Histogram = ({ data }: { data: HistogramData | null }) => (
		<div className="histogram">
			{data ? (
				<div className="histogram-bars">
					{data.luminance.map((value, index) => (
						<div
							key={index}
							className="histogram-bar"
							style={{
								height: `${Math.min(value * 100, 100)}%`,
								background: `linear-gradient(to top,
									rgba(${data.red[index] * 255}, ${data.green[index] * 255}, ${data.blue[index] * 255}, 0.8),
									rgba(${data.red[index] * 255}, ${data.green[index] * 255}, ${data.blue[index] * 255}, 0.2)
								)`,
							}}
						/>
					))}
				</div>
			) : (
				<div className="flex items-center justify-center h-full text-gray-500">
					<span>No histogram data</span>
				</div>
			)}
		</div>
	);

	return (
		<div className="flex h-screen bg-gray-900 text-white">
			{/* Left Sidebar - File Browser & Info */}
			<div className="w-80 bg-gray-800 border-r border-gray-700 flex flex-col">
				{/* Header */}
				<div className="p-4 border-b border-gray-700">
					<div className="flex items-center space-x-4 mb-2">
						<div className="flex items-center space-x-2">
							<div
								className={`status-indicator ${previewState.isProcessing ? "processing" : shadeStatus?.running ? "online" : "offline"}`}
							></div>
							<span className="text-sm text-gray-400">
								{previewState.isProcessing
									? "Processing..."
									: shadeStatus?.running
										? "Ready"
										: "Disconnected"}
							</span>
						</div>
					</div>

					<button
						type="button"
						onClick={selectFile}
						className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors font-medium tooltip"
						data-tooltip="Cmd+I"
					>
						📁 Import Image
					</button>
				</div>

				{/* Image Info */}
				{previewState.original && (
					<div className="p-4 border-b border-gray-700">
						<h3 className="font-medium mb-2">Image Info</h3>
						<div className="space-y-1 text-sm text-gray-400">
							<div>Name: {previewState.original.name}</div>
							<div>
								Size: {previewState.original.width} ×{" "}
								{previewState.original.height}
							</div>
							<div>Operations: {operations.length}</div>
							<div>
								Format:{" "}
								{previewState.original.name.split(".").pop()?.toUpperCase() ||
									"Unknown"}
							</div>
						</div>
					</div>
				)}

				{/* History Panel */}
				<div className="p-4 flex-1">
					<h3 className="font-medium mb-2">History</h3>
					<div className="space-y-2 text-sm text-gray-400">
						<div className="p-2 bg-gray-700 rounded">Original Import</div>
						{operations.map((op, index) => (
							<div
								key={`${op.operation}-${index}`}
								className="p-2 bg-gray-700 rounded"
							>
								{op.operation}:{" "}
								{typeof op.params === "object"
									? JSON.stringify(op.params)
									: op.params}
							</div>
						))}
					</div>
				</div>

				{/* Status & Actions */}
				<div className="p-4 border-t border-gray-700 space-y-2">
					{/* Status Information */}
					<div className="pt-2 border-t border-gray-600">
						<div className="text-xs text-gray-400 mb-2">Status</div>
						<div className="space-y-1 text-xs">
							<div className="flex justify-between">
								<span className="text-gray-400">Operations:</span>
								<span className="text-white">{operations.length}</span>
							</div>
							<div className="flex justify-between">
								<span className="text-gray-400">Processing:</span>
								<span
									className={
										previewState.isProcessing
											? "text-yellow-400"
											: "text-green-400"
									}
								>
									{previewState.isProcessing ? "Yes" : "No"}
								</span>
							</div>
							<div className="flex justify-between">
								<span className="text-gray-400">Shade Server:</span>
								<span
									className={
										shadeStatus?.running ? "text-green-400" : "text-red-400"
									}
								>
									{shadeStatus?.running ? "Running" : "Stopped"}
								</span>
							</div>
							{shadeStatus?.running && (
								<div className="flex justify-between">
									<span className="text-gray-400">Pending:</span>
									<span className="text-white">
										{shadeStatus.pending_requests}
									</span>
								</div>
							)}

							{operations.length > 0 && (
								<div className="pt-1 border-t border-gray-700 mt-1">
									<div className="text-xs text-gray-400 mb-1">
										Current Operations
									</div>
									{operations.map((op, index) => (
										<div key={index} className="text-xs text-gray-300">
											{index + 1}. {op.operation}
											{typeof op.params === "number"
												? ` (${op.params.toFixed(2)})`
												: op.params && typeof op.params === "object"
													? ` (${JSON.stringify(op.params).substring(0, 20)}...)`
													: ""}
										</div>
									))}
								</div>
							)}
							<div className="flex justify-between">
								<span className="text-gray-400">Image Loaded:</span>
								<span
									className={
										previewState.original?.src
											? "text-green-400"
											: "text-red-400"
									}
								>
									{previewState.original?.src ? "Yes" : "No"}
								</span>
							</div>
							{selectedFile && (
								<div className="pt-1 border-t border-gray-700 mt-1">
									<div className="text-xs text-gray-400 mb-1">Debug Info</div>
									<div className="text-xs text-gray-300 break-all">
										File: {selectedFile.split("/").pop()}
									</div>
									{previewState.original?.src && (
										<div className="text-xs text-gray-300 break-all mt-1">
											Method:{" "}
											{previewState.original.src.startsWith("blob:")
												? "Binary Blob"
												: "File URL"}
										</div>
									)}
									{previewState.original?.src && (
										<div className="text-xs text-gray-300 break-all mt-1">
											URL: {previewState.original?.src.substring(0, 50)}...
										</div>
									)}
								</div>
							)}
						</div>
					</div>

					{/* Debug/Test Controls */}
					{error && (
						<div className="mt-2 p-2 bg-red-900/50 border border-red-700 rounded text-sm text-red-200">
							{error}
						</div>
					)}
				</div>
			</div>

			{/* Center - Image Preview */}
			<div className="flex-1 flex flex-col">
				{/* Preview Area */}
				<div className="flex-1 flex items-center justify-center bg-gray-900 p-4">
					{selectedFile && previewState.original ? (
						<div className="relative max-w-full max-h-full">
							<div className="text-center">
								<div className="relative mb-4">
									{previewState.isProcessing && (
										<div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center z-10 rounded-lg">
											<div className="flex items-center space-x-2 text-blue-400">
												<div className="loading-spinner"></div>
												<span>Processing...</span>
											</div>
										</div>
									)}
									{previewState.processed?.src || previewState.original.src ? (
										<img
											src={
												previewState.processed?.src || previewState.original.src
											}
											alt="Preview"
											className="max-w-full max-h-96 object-contain"
											style={{ maxHeight: "calc(100vh - 300px)" }}
											onError={(e) => {
												console.error(
													"Preview image error for:",
													previewState.processed?.src ||
														previewState.original.src,
												);
												const target = e.target as HTMLImageElement;
												target.style.display = "none";
												target.nextElementSibling?.classList.remove("hidden");
											}}
										/>
									) : (
										<div className="max-w-full flex items-center justify-center">
											<div className="text-center text-gray-500">
												<div className="text-6xl mb-4">⚠️</div>
												<div className="text-lg mb-2">Unable to Load Image</div>
												<div className="text-sm text-gray-400 max-w-md">
													The selected image could not be loaded. This might be
													due to:
												</div>
												<div className="text-xs text-gray-400 mt-2 space-y-1">
													<div>• File permissions restrictions</div>
													<div>• Unsupported image format</div>
													<div>• File path contains special characters</div>
													<div>• File has been moved or deleted</div>
												</div>
												<div className="text-xs text-blue-400 mt-3">
													Check browser console for detailed error info
												</div>
											</div>
										</div>
									)}
									<div className="hidden text-center py-20 text-gray-500">
										<div className="text-4xl mb-2">❌</div>
										<div>Failed to load image</div>
									</div>
								</div>
							</div>
						</div>
					) : (
						<div className="text-center text-gray-500">
							<div className="text-6xl mb-4">📁</div>
							<div className="text-xl mb-2">No image selected</div>
							<div className="text-sm">Click Import Image to get started</div>
						</div>
					)}
				</div>
			</div>

			{/* Right Sidebar - Adjustment Panels */}
			<div className="w-80 bg-gray-800 border-l border-gray-700 flex flex-col">
				{/* Panel Navigation */}
				<div className="p-4 border-b border-gray-700">
					<div className="grid grid-cols-2 gap-2 mb-2">
						<PanelButton id="basic" label="Basic" icon="🔆" shortcut="1" />
						<PanelButton id="tone" label="Tone" icon="📊" shortcut="2" />
						<PanelButton id="color" label="Color" icon="🎨" shortcut="3" />
						<PanelButton id="effects" label="Effects" icon="✨" shortcut="4" />
					</div>
					<div className="w-full">
						<PanelButton
							id="histogram"
							label="Histogram"
							icon="📈"
							shortcut="5"
						/>
					</div>
				</div>

				{/* Adjustment Controls */}
				<div className="flex-1 p-4 overflow-y-auto">
					{activePanel === "basic" && (
						<div>
							<h3 className="font-medium mb-4 text-lg">Basic Adjustments</h3>
							<Slider
								label="Exposure"
								value={adjustments.exposure}
								min={-2.0}
								max={2.0}
								onChange={(value) => updateAdjustment("exposure", value)}
							/>
							<Slider
								label="Highlights"
								value={adjustments.highlights}
								min={-100}
								max={100}
								step={1}
								onChange={(value) => updateAdjustment("highlights", value)}
							/>
							<Slider
								label="Shadows"
								value={adjustments.shadows}
								min={-100}
								max={100}
								step={1}
								onChange={(value) => updateAdjustment("shadows", value)}
							/>
							<Slider
								label="Whites"
								value={adjustments.whites}
								min={-100}
								max={100}
								step={1}
								onChange={(value) => updateAdjustment("whites", value)}
							/>
							<Slider
								label="Blacks"
								value={adjustments.blacks}
								min={-100}
								max={100}
								step={1}
								onChange={(value) => updateAdjustment("blacks", value)}
							/>
						</div>
					)}

					{activePanel === "tone" && (
						<div>
							<h3 className="font-medium mb-4 text-lg">Tone Curve</h3>
							<Slider
								label="Brightness"
								value={adjustments.brightness}
								min={0.1}
								max={2.0}
								onChange={(value) => updateAdjustment("brightness", value)}
							/>
							<Slider
								label="Contrast"
								value={adjustments.contrast}
								min={0.1}
								max={2.0}
								onChange={(value) => updateAdjustment("contrast", value)}
							/>
							<Slider
								label="Gamma"
								value={adjustments.gamma}
								min={0.1}
								max={3.0}
								onChange={(value) => updateAdjustment("gamma", value)}
							/>
						</div>
					)}

					{activePanel === "color" && (
						<div>
							<h3 className="font-medium mb-4 text-lg">Color Adjustments</h3>
							<Slider
								label="Temperature"
								value={adjustments.temperature}
								min={-1.0}
								max={1.0}
								onChange={(value) => updateAdjustment("temperature", value)}
							/>
							<Slider
								label="Tint"
								value={adjustments.tint}
								min={-1.0}
								max={1.0}
								onChange={(value) => updateAdjustment("tint", value)}
							/>
							<Slider
								label="Saturation"
								value={adjustments.saturation}
								min={0.0}
								max={2.0}
								onChange={(value) => updateAdjustment("saturation", value)}
							/>
							<Slider
								label="Vibrance"
								value={adjustments.vibrance}
								min={-100}
								max={100}
								step={1}
								onChange={(value) => updateAdjustment("vibrance", value)}
							/>
							<Slider
								label="Hue"
								value={adjustments.hue}
								min={-180}
								max={180}
								step={1}
								onChange={(value) => updateAdjustment("hue", value)}
								unit="°"
							/>
						</div>
					)}

					{activePanel === "effects" && (
						<div>
							<h3 className="font-medium mb-4 text-lg">Effects</h3>
							<Slider
								label="Clarity"
								value={adjustments.clarity}
								min={-100}
								max={100}
								step={1}
								onChange={(value) => updateAdjustment("clarity", value)}
							/>
							<Slider
								label="Dehaze"
								value={adjustments.dehaze}
								min={-100}
								max={100}
								step={1}
								onChange={(value) => updateAdjustment("dehaze", value)}
							/>
							<Slider
								label="Blur"
								value={adjustments.blur}
								min={0.0}
								max={10.0}
								onChange={(value) => updateAdjustment("blur", value)}
							/>
							<Slider
								label="Sharpen"
								value={adjustments.sharpen}
								min={0.0}
								max={2.0}
								onChange={(value) => updateAdjustment("sharpen", value)}
							/>
							<Slider
								label="Noise"
								value={adjustments.noise}
								min={0.0}
								max={1.0}
								onChange={(value) => updateAdjustment("noise", value)}
							/>
						</div>
					)}

					{activePanel === "histogram" && (
						<div>
							<h3 className="font-medium mb-4 text-lg">Histogram</h3>
							<div className="mb-6">
								<Histogram data={histogram} />
							</div>

							{histogram && (
								<div className="space-y-3">
									<div className="text-sm">
										<div className="flex justify-between items-center mb-1">
											<span className="text-gray-300">RGB Channels</span>
										</div>
										<div className="flex space-x-4">
											<div className="flex items-center space-x-2">
												<div className="w-3 h-3 bg-red-500 rounded"></div>
												<span className="text-xs text-gray-400">Red</span>
											</div>
											<div className="flex items-center space-x-2">
												<div className="w-3 h-3 bg-green-500 rounded"></div>
												<span className="text-xs text-gray-400">Green</span>
											</div>
											<div className="flex items-center space-x-2">
												<div className="w-3 h-3 bg-blue-500 rounded"></div>
												<span className="text-xs text-gray-400">Blue</span>
											</div>
										</div>
									</div>

									<div className="pt-4 border-t border-gray-600">
										<div className="text-sm text-gray-300 mb-2">Statistics</div>
										<div className="text-xs text-gray-400 space-y-1">
											<div>
												Mean:{" "}
												{(
													(histogram.luminance.reduce((a, b) => a + b, 0) /
														histogram.luminance.length) *
													255
												).toFixed(1)}
											</div>
											<div>
												Shadows:{" "}
												{histogram.luminance
													.slice(0, 85)
													.reduce((a, b) => a + b, 0)
													.toFixed(3)}
											</div>
											<div>
												Midtones:{" "}
												{histogram.luminance
													.slice(85, 170)
													.reduce((a, b) => a + b, 0)
													.toFixed(3)}
											</div>
											<div>
												Highlights:{" "}
												{histogram.luminance
													.slice(170)
													.reduce((a, b) => a + b, 0)
													.toFixed(3)}
											</div>
										</div>
									</div>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Keyboard Shortcuts Help */}
			<div className="fixed bottom-4 right-4 text-xs text-gray-500 bg-gray-800 border border-gray-700 rounded-lg p-2 opacity-0 hover:opacity-100 transition-opacity">
				<div className="font-medium mb-1">Keyboard Shortcuts</div>
				<div className="space-y-0.5">
					<div>Cmd+I: Import Image</div>
					<div>B: Toggle Before/After</div>
					<div>1-5: Switch Panels</div>
				</div>
			</div>
		</div>
	);
};

export default ImageProcessor;
