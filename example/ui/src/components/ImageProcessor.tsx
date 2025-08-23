import React, { useState, useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
	ShadeAPI,
	ProcessImageResult,
	ShadeStatus,
	OperationSpec,
} from "../lib/shade-api";

interface ImageProcessorProps {}

const ImageProcessor: React.FC<ImageProcessorProps> = () => {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [processing, setProcessing] = useState(false);
	const [result, setResult] = useState<ProcessImageResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [shadeStatus, setShadeStatus] = useState<ShadeStatus | null>(null);
	const [operations, setOperations] = useState<OperationSpec[]>([]);

	// Operation controls
	const [brightness, setBrightness] = useState(1.0);
	const [contrast, setContrast] = useState(1.0);
	const [saturation, setSaturation] = useState(1.0);
	const [hue, setHue] = useState(0.0);
	const [gamma, setGamma] = useState(1.0);

	// Update operations when controls change
	useEffect(() => {
		const newOperations: OperationSpec[] = [];

		if (brightness !== 1.0) {
			newOperations.push(ShadeAPI.operations.brightness(brightness));
		}
		if (contrast !== 1.0) {
			newOperations.push(ShadeAPI.operations.contrast(contrast));
		}
		if (saturation !== 1.0) {
			newOperations.push(ShadeAPI.operations.saturation(saturation));
		}
		if (hue !== 0.0) {
			newOperations.push(ShadeAPI.operations.hue(hue));
		}
		if (gamma !== 1.0) {
			newOperations.push(ShadeAPI.operations.gamma(gamma));
		}

		setOperations(newOperations);
	}, [brightness, contrast, saturation, hue, gamma]);

	// Check Shade status on component mount
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

		// Poll status every 5 seconds
		const interval = setInterval(checkStatus, 5000);
		return () => clearInterval(interval);
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
						],
					},
				],
			});

			if (selected && typeof selected === "string") {
				setSelectedFile(selected);
				setResult(null);
				setError(null);
			}
		} catch (err) {
			setError(`Failed to select file: ${err}`);
		}
	}, []);

	const processImage = useCallback(async () => {
		if (!selectedFile) {
			setError("No file selected");
			return;
		}

		if (operations.length === 0) {
			setError("No operations to apply");
			return;
		}

		setProcessing(true);
		setError(null);
		setResult(null);

		try {
			const result = await ShadeAPI.processImageFile(
				selectedFile,
				operations,
				"png",
			);
			setResult(result);
		} catch (err) {
			setError(`Processing failed: ${err}`);
		} finally {
			setProcessing(false);
		}
	}, [selectedFile, operations]);

	const resetControls = useCallback(() => {
		setBrightness(1.0);
		setContrast(1.0);
		setSaturation(1.0);
		setHue(0.0);
		setGamma(1.0);
	}, []);

	const restartShade = useCallback(async () => {
		try {
			await ShadeAPI.restartShade();
			const status = await ShadeAPI.getShadeStatus();
			setShadeStatus(status);
		} catch (err) {
			setError(`Failed to restart Shade: ${err}`);
		}
	}, []);

	return (
		<div className="image-processor p-6 max-w-4xl mx-auto">
			<h1 className="text-3xl font-bold mb-6 text-gray-800">
				Shade Image Processor
			</h1>

			{/* Status Panel */}
			<div className="mb-6 p-4 bg-gray-100 rounded-lg">
				<h2 className="text-lg font-semibold mb-2">Shade Status</h2>
				{shadeStatus ? (
					<div className="grid grid-cols-3 gap-4 text-sm">
						<div>
							<span className="font-medium">Status:</span>{" "}
							<span
								className={`px-2 py-1 rounded ${shadeStatus.running ? "bg-green-200 text-green-800" : "bg-red-200 text-red-800"}`}
							>
								{shadeStatus.running ? "Running" : "Stopped"}
							</span>
						</div>
						<div>
							<span className="font-medium">Pending Requests:</span>{" "}
							{shadeStatus.pending_requests}
						</div>
						<div>
							<span className="font-medium">Message Counter:</span>{" "}
							{shadeStatus.message_counter}
						</div>
					</div>
				) : (
					<div>Loading status...</div>
				)}
				<button
					onClick={restartShade}
					className="mt-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
					disabled={processing}
				>
					Restart Shade
				</button>
			</div>

			{/* File Selection */}
			<div className="mb-6 p-4 border border-gray-300 rounded-lg">
				<h2 className="text-lg font-semibold mb-2">Select Image</h2>
				<button
					onClick={selectFile}
					className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
					disabled={processing}
				>
					Select Image File
				</button>
				{selectedFile && (
					<div className="mt-2 text-sm text-gray-600">
						Selected: {selectedFile.split("/").pop()}
					</div>
				)}
			</div>

			{/* Operation Controls */}
			<div className="mb-6 p-4 border border-gray-300 rounded-lg">
				<h2 className="text-lg font-semibold mb-4">Image Adjustments</h2>
				<div className="grid grid-cols-2 gap-6">
					<div>
						<label className="block text-sm font-medium text-gray-700 mb-1">
							Brightness: {brightness.toFixed(2)}
						</label>
						<input
							type="range"
							min="0.1"
							max="3.0"
							step="0.1"
							value={brightness}
							onChange={(e) => setBrightness(parseFloat(e.target.value))}
							className="w-full"
							disabled={processing}
						/>
					</div>

					<div>
						<label className="block text-sm font-medium text-gray-700 mb-1">
							Contrast: {contrast.toFixed(2)}
						</label>
						<input
							type="range"
							min="0.1"
							max="3.0"
							step="0.1"
							value={contrast}
							onChange={(e) => setContrast(parseFloat(e.target.value))}
							className="w-full"
							disabled={processing}
						/>
					</div>

					<div>
						<label className="block text-sm font-medium text-gray-700 mb-1">
							Saturation: {saturation.toFixed(2)}
						</label>
						<input
							type="range"
							min="0.0"
							max="2.0"
							step="0.1"
							value={saturation}
							onChange={(e) => setSaturation(parseFloat(e.target.value))}
							className="w-full"
							disabled={processing}
						/>
					</div>

					<div>
						<label className="block text-sm font-medium text-gray-700 mb-1">
							Hue: {hue.toFixed(1)}°
						</label>
						<input
							type="range"
							min="-180"
							max="180"
							step="10"
							value={hue}
							onChange={(e) => setHue(parseFloat(e.target.value))}
							className="w-full"
							disabled={processing}
						/>
					</div>

					<div>
						<label className="block text-sm font-medium text-gray-700 mb-1">
							Gamma: {gamma.toFixed(2)}
						</label>
						<input
							type="range"
							min="0.1"
							max="3.0"
							step="0.1"
							value={gamma}
							onChange={(e) => setGamma(parseFloat(e.target.value))}
							className="w-full"
							disabled={processing}
						/>
					</div>
				</div>

				<div className="mt-4 flex gap-4">
					<button
						onClick={resetControls}
						className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
						disabled={processing}
					>
						Reset All
					</button>

					<div className="text-sm text-gray-600 flex items-center">
						Operations to apply: {operations.length}
					</div>
				</div>
			</div>

			{/* Process Button */}
			<div className="mb-6">
				<button
					onClick={processImage}
					disabled={
						!selectedFile ||
						operations.length === 0 ||
						processing ||
						!shadeStatus?.running
					}
					className={`px-6 py-3 text-white rounded-lg font-semibold ${
						!selectedFile ||
						operations.length === 0 ||
						processing ||
						!shadeStatus?.running
							? "bg-gray-400 cursor-not-allowed"
							: "bg-blue-500 hover:bg-blue-600"
					}`}
				>
					{processing ? "Processing..." : "Process Image"}
				</button>
			</div>

			{/* Error Display */}
			{error && (
				<div className="mb-6 p-4 bg-red-100 border border-red-400 rounded-lg">
					<h3 className="text-red-800 font-semibold">Error</h3>
					<p className="text-red-700 text-sm">{error}</p>
				</div>
			)}

			{/* Result Display */}
			{result && (
				<div className="mb-6 p-4 bg-green-100 border border-green-400 rounded-lg">
					<h3 className="text-green-800 font-semibold mb-2">
						Processing Complete
					</h3>
					<div className="grid grid-cols-2 gap-4 text-sm text-green-700">
						<div>
							<span className="font-medium">Dimensions:</span> {result.width} ×{" "}
							{result.height}
						</div>
						<div>
							<span className="font-medium">Format:</span> {result.format}
						</div>
						<div className="col-span-2">
							<span className="font-medium">Image ID:</span>{" "}
							{result.image_attachment_id}
						</div>
					</div>
					<div className="mt-2 text-xs text-gray-600">
						Note: The processed image is stored as a binary attachment with the
						above ID. In a full implementation, you would need to handle
						retrieving and displaying the binary data.
					</div>
				</div>
			)}

			{/* Operations Preview */}
			{operations.length > 0 && (
				<div className="p-4 bg-blue-50 border border-blue-300 rounded-lg">
					<h3 className="text-blue-800 font-semibold mb-2">
						Operations to Apply
					</h3>
					<ul className="text-sm text-blue-700 space-y-1">
						{operations.map((op, index) => (
							<li key={index} className="flex items-center gap-2">
								<span className="font-medium">{op.operation}:</span>
								<span>
									{typeof op.params === "object"
										? JSON.stringify(op.params)
										: op.params}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
};

export default ImageProcessor;
