import type React from "react";
import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import type {
	ProcessImageResult,
	ShadeStatus,
	OperationSpec,
} from "../lib/shade-api";
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

	// Generate histogram data (simplified simulation)
	const generateHistogram = useCallback((imageSrc: string): HistogramData => {
		// In a real implementation, this would analyze the actual image pixels
		// For now, we'll generate realistic-looking histogram data
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

	// Update operations when adjustments change
	useEffect(() => {
		const newOperations: OperationSpec[] = [];

		// Basic adjustments - map to available operations
		if (adjustments.brightness !== 1.0) {
			newOperations.push(
				ShadeAPI.operations.brightness(adjustments.brightness),
			);
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

		setOperations(newOperations);
	}, [adjustments]);

	// Live preview with debouncing
	useEffect(() => {
		if (!selectedFile || operations.length === 0) {
			return;
		}

		if (previewTimeoutRef.current) {
			clearTimeout(previewTimeoutRef.current);
		}

		previewTimeoutRef.current = setTimeout(async () => {
			setPreviewState((prev) => ({ ...prev, isProcessing: true }));

			try {
				const result = await ShadeAPI.processImageFile(
					selectedFile,
					operations,
					"png",
				);

				// Note: In a full implementation, you would need to handle binary attachments
				// and convert them to displayable images. For now, this shows the structure.
				setPreviewState((prev) => ({
					...prev,
					processed: prev.original
						? {
								...prev.original,
								src: prev.original.src, // Would be replaced with processed image data
							}
						: null,
					isProcessing: false,
				}));
			} catch (err) {
				setError(`Preview failed: ${err}`);
				setPreviewState((prev) => ({ ...prev, isProcessing: false }));
			}
		}, 300);
	}, [selectedFile, operations]);

	const resetAll = useCallback(() => {
		setAdjustments({
			exposure: 0.0,
			highlights: 0.0,
			shadows: 0.0,
			whites: 0.0,
			blacks: 0.0,
			brightness: 1.0,
			contrast: 1.0,
			gamma: 1.0,
			saturation: 1.0,
			vibrance: 0.0,
			hue: 0.0,
			temperature: 0.0,
			tint: 0.0,
			clarity: 0.0,
			dehaze: 0.0,
			blur: 0.0,
			sharpen: 0.0,
			noise: 0.0,
		});
	}, []);

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

				// Load original image for preview
				const imageSrc = convertFileSrc(selected);
				const img = new Image();
				img.onload = () => {
					const imageData: ImageData = {
						src: imageSrc,
						width: img.naturalWidth,
						height: img.naturalHeight,
						name: selected.split("/").pop() || "Unknown",
					};

					setPreviewState({
						original: imageData,
						processed: null,
						isProcessing: false,
					});

					// Generate histogram for the loaded image
					setHistogram(generateHistogram(imageSrc));
				};
				img.onerror = () => {
					// Fallback if image can't be loaded
					setPreviewState({
						original: {
							src: imageSrc,
							width: 1920,
							height: 1080,
							name: selected.split("/").pop() || "Unknown",
						},
						processed: null,
						isProcessing: false,
					});
				};
				img.src = imageSrc;
			}
		} catch (err) {
			setError(`Failed to select file: ${err}`);
		}
	}, []);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Cmd/Ctrl + R to reset all adjustments
			if ((event.metaKey || event.ctrlKey) && event.key === "r") {
				event.preventDefault();
				resetAll();
			}
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
	}, [resetAll, selectFile, showBeforeAfter, previewState.original]);

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
					<div className="flex items-center justify-between mb-4">
						<h1 className="text-xl font-semibold">Shade</h1>
						<div
							className={`status-indicator ${shadeStatus?.running ? "online" : "offline"}`}
						></div>
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

						{/* Mini Histogram */}
						<div className="mt-4">
							<h4 className="text-sm font-medium mb-2 text-gray-300">
								Histogram
							</h4>
							<div className="h-16 bg-gray-700 rounded border">
								<Histogram data={histogram} />
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
				<div className="p-4 border-t border-gray-700">
					<button
						type="button"
						onClick={resetAll}
						className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors tooltip"
						data-tooltip="Cmd+R"
					>
						🔄 Reset All
					</button>
					{error && (
						<div className="mt-2 p-2 bg-red-900/50 border border-red-700 rounded text-sm text-red-200">
							{error}
						</div>
					)}
				</div>
			</div>

			{/* Center - Image Preview */}
			<div className="flex-1 flex flex-col">
				{/* Preview Header */}
				<div className="p-4 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
					<div className="flex items-center space-x-4">
						<button
							type="button"
							onClick={() => setShowBeforeAfter(!showBeforeAfter)}
							className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors tooltip ${
								showBeforeAfter
									? "bg-blue-600 text-white"
									: "bg-gray-700 text-gray-300 hover:bg-gray-600"
							}`}
							disabled={!previewState.original}
							data-tooltip="Press B"
						>
							📊 Before/After
						</button>
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

					<div className="flex items-center space-x-2">
						<button
							type="button"
							className="p-2 hover:bg-gray-700 rounded transition-colors"
							disabled={!previewState.original}
						>
							🔍-
						</button>
						<span className="text-sm text-gray-400 min-w-12 text-center">
							100%
						</span>
						<button
							type="button"
							className="p-2 hover:bg-gray-700 rounded transition-colors"
							disabled={!previewState.original}
						>
							🔍+
						</button>
						<div className="w-px h-6 bg-gray-600 mx-2"></div>
						<button
							type="button"
							className="p-2 hover:bg-gray-700 rounded transition-colors text-sm"
							disabled={!previewState.original}
						>
							⤢ Fit
						</button>
					</div>
				</div>

				{/* Preview Area */}
				<div className="flex-1 flex items-center justify-center bg-gray-900 p-8">
					{selectedFile && previewState.original ? (
						<div className="relative max-w-full max-h-full">
							{showBeforeAfter ? (
								<div className="flex space-x-8">
									<div className="text-center">
										<div className="text-sm text-gray-400 mb-3">Before</div>
										<div className="relative image-preview">
											<img
												src={previewState.original.src}
												alt="Original"
												className="w-80 h-60 object-contain bg-gray-700 rounded-lg"
												onError={(e) => {
													const target = e.target as HTMLImageElement;
													target.style.display = "none";
													target.nextElementSibling?.classList.remove("hidden");
												}}
											/>
											<div className="hidden w-80 h-60 bg-gray-700 rounded-lg flex items-center justify-center">
												<span className="text-gray-500">
													Failed to load image
												</span>
											</div>
										</div>
									</div>
									<div className="text-center">
										<div className="text-sm text-gray-400 mb-3">After</div>
										<div className="w-80 h-60 bg-gray-700 rounded-lg flex items-center justify-center image-preview">
											{previewState.isProcessing ? (
												<div className="flex items-center space-x-2 text-blue-400">
													<div className="loading-spinner"></div>
													<span>Processing...</span>
												</div>
											) : previewState.processed ? (
												<img
													src={previewState.processed.src}
													alt="Processed"
													className="w-full h-full object-contain"
												/>
											) : (
												<div className="text-center text-gray-500">
													<div className="text-4xl mb-2">⚡</div>
													<div>Live Preview</div>
													<div className="text-xs text-gray-600 mt-1">
														Adjust settings to see changes
													</div>
												</div>
											)}
										</div>
									</div>
								</div>
							) : (
								<div className="text-center">
									<div className="relative image-preview mb-4">
										{previewState.isProcessing && (
											<div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center z-10 rounded-lg">
												<div className="flex items-center space-x-2 text-blue-400">
													<div className="loading-spinner"></div>
													<span>Processing...</span>
												</div>
											</div>
										)}
										<img
											src={
												previewState.processed?.src || previewState.original.src
											}
											alt="Preview"
											className="max-w-full max-h-96 object-contain bg-gray-700 rounded-lg"
											style={{ maxHeight: "calc(100vh - 300px)" }}
											onError={(e) => {
												const target = e.target as HTMLImageElement;
												target.style.display = "none";
												target.nextElementSibling?.classList.remove("hidden");
											}}
										/>
										<div className="hidden w-96 h-72 bg-gray-700 rounded-lg flex items-center justify-center">
											<span className="text-gray-500">
												Failed to load image
											</span>
										</div>
									</div>
									<div className="text-sm text-gray-400">
										{previewState.original.name}
									</div>
									<div className="text-xs text-gray-600 mt-1">
										{previewState.original.width} ×{" "}
										{previewState.original.height} pixels
									</div>
								</div>
							)}
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
					<div>Cmd+R: Reset All</div>
					<div>B: Toggle Before/After</div>
					<div>1-5: Switch Panels</div>
				</div>
			</div>
		</div>
	);
};

export default ImageProcessor;
