import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Download,
  Eye,
  EyeOff,
  Image as ImageIcon,
  RotateCcw,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

interface ImageOperation {
  operation: string;
  params: unknown;
}

interface ProcessImageResult {
  image_data: string;
  width: number;
  height: number;
  format: string;
}

interface ServerCapabilities {
  supported_operations: string[];
  supported_input_formats: string[];
  supported_output_formats: string[];
}

interface InitializeResult {
  capabilities: ServerCapabilities;
  server_info: Record<string, string>;
}

interface ImageProcessingState {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  gamma: number;
  blur: number;
  sharpen: number;
  noise: number;
  scale: number;
  rotate: number;
  whiteBalance: {
    auto_adjust: boolean;
    temperature: number;
    tint: number;
  };
}

const DEFAULT_STATE: ImageProcessingState = {
  brightness: 1.0,
  contrast: 1.0,
  saturation: 1.0,
  hue: 0.0,
  gamma: 1.0,
  blur: 0.0,
  sharpen: 0.0,
  noise: 0.0,
  scale: 1.0,
  rotate: 0.0,
  whiteBalance: {
    auto_adjust: false,
    temperature: 5500.0,
    tint: 0.0,
  },
};

function App() {
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [processedImage, setProcessedImage] = useState<string | null>(null);
  const [imageInfo, setImageInfo] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [state, setState] = useState<ImageProcessingState>(DEFAULT_STATE);
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [zoom, setZoom] = useState(100);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingTimeoutRef = useRef<number | undefined>();

  // Initialize shade process
  useEffect(() => {
    let mounted = true;

    const initializeShade = async () => {
      try {
        await invoke("start_shade_process");
        const result = await invoke<InitializeResult>("initialize_shade");

        if (mounted) {
          setCapabilities(result.capabilities);
          setIsConnected(true);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(`Failed to initialize Shade: ${err}`);
          setIsConnected(false);
        }
      }
    };

    initializeShade();

    return () => {
      mounted = false;
      if (processingTimeoutRef.current !== undefined) {
        clearTimeout(processingTimeoutRef.current);
      }
    };
  }, []);

  // Process image with debouncing
  const processImage = useCallback(
    async (operations: ImageOperation[]) => {
      if (!originalImage || !previewEnabled || isProcessing) return;

      setIsProcessing(true);
      setError(null);

      try {
        const result = await invoke<ProcessImageResult>(
          "process_image_base64",
          {
            imageData: originalImage.split(",")[1], // Remove data:image/...;base64, prefix
            operations,
            outputFormat: "png",
          },
        );

        setProcessedImage(`data:image/png;base64,${result.image_data}`);
        setImageInfo({ width: result.width, height: result.height });
      } catch (err) {
        setError(`Processing failed: ${err}`);
        setProcessedImage(null);
      } finally {
        setIsProcessing(false);
      }
    },
    [originalImage, previewEnabled, isProcessing],
  );

  // Debounced processing
  useEffect(() => {
    if (!originalImage || !previewEnabled) return;

    // Clear existing timeout
    if (processingTimeoutRef.current !== undefined) {
      clearTimeout(processingTimeoutRef.current);
    }

    // Create operations array from current state
    const operations: ImageOperation[] = [];

    if (state.brightness !== 1.0)
      operations.push({ operation: "brightness", params: state.brightness });
    if (state.contrast !== 1.0)
      operations.push({ operation: "contrast", params: state.contrast });
    if (state.saturation !== 1.0)
      operations.push({ operation: "saturation", params: state.saturation });
    if (state.hue !== 0.0)
      operations.push({ operation: "hue", params: state.hue });
    if (state.gamma !== 1.0)
      operations.push({ operation: "gamma", params: state.gamma });
    if (state.blur > 0.0)
      operations.push({ operation: "blur", params: state.blur });
    if (state.sharpen > 0.0)
      operations.push({ operation: "sharpen", params: state.sharpen });
    if (state.noise > 0.0)
      operations.push({ operation: "noise", params: state.noise });
    if (state.scale !== 1.0)
      operations.push({ operation: "scale", params: state.scale });
    if (state.rotate !== 0.0)
      operations.push({ operation: "rotate", params: state.rotate });
    if (
      state.whiteBalance.auto_adjust ||
      state.whiteBalance.temperature !== 5500.0 ||
      state.whiteBalance.tint !== 0.0
    ) {
      operations.push({
        operation: "white_balance",
        params: state.whiteBalance,
      });
    }

    // Set timeout for processing
    processingTimeoutRef.current = window.setTimeout(() => {
      processImage(operations);
    }, 300); // 300ms debounce
  }, [state, processImage, originalImage, previewEnabled]);

  const handleFileSelect = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "bmp", "tiff"],
          },
        ],
      });

      if (selected && typeof selected === "string") {
        // Read file and convert to base64
        const response = await fetch(`file://${selected}`);
        const blob = await response.blob();
        const reader = new FileReader();

        reader.onload = (e) => {
          if (e.target?.result) {
            setOriginalImage(e.target.result as string);
            setProcessedImage(null);
            setImageInfo(null);
            setError(null);
          }
        };

        reader.readAsDataURL(blob);
      }
    } catch (err) {
      setError(`Failed to load image: ${err}`);
      console.error("File selection error:", err);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const imageFile = files.find((file) => file.type.startsWith("image/"));

    if (imageFile) {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result) {
          setOriginalImage(e.target.result as string);
          setProcessedImage(null);
          setImageInfo(null);
          setError(null);
        }
      };
      reader.readAsDataURL(imageFile);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleReset = () => {
    setState(DEFAULT_STATE);
  };

  const handleExport = async () => {
    if (!processedImage) return;

    try {
      const link = document.createElement("a");
      link.href = processedImage;
      link.download = "processed-image.png";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      setError(`Export failed: ${err}`);
    }
  };

  const updateState = (key: keyof ImageProcessingState, value: unknown) => {
    setState((prev) => ({ ...prev, [key]: value }));
  };

  const updateWhiteBalance = (
    key: keyof typeof DEFAULT_STATE.whiteBalance,
    value: unknown,
  ) => {
    setState((prev) => ({
      ...prev,
      whiteBalance: { ...prev.whiteBalance, [key]: value },
    }));
  };

  // const displayImage = previewEnabled ? (processedImage || originalImage) : originalImage;

  return (
    <div className="bg-gray-800 text-white min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-gray-900 p-4 shadow-md flex justify-between items-center">
        <h1 className="text-2xl font-semibold">Shade Image Processor</h1>
        <div className="flex items-center space-x-2">
          <div
            className={`w-3 h-3 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`}
          ></div>
          <span>{isConnected ? "Connected" : "Disconnected"}</span>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-1/4 bg-gray-850 p-6 overflow-y-auto space-y-6">
          {/* Image Upload */}
          <div className="space-y-2">
            <h3 className="text-lg font-medium">Image Upload</h3>
            <button
              onClick={handleFileSelect}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              type="button"
              className="w-full h-32 flex flex-col items-center justify-center border-2 border-dashed border-gray-600 rounded-lg cursor-pointer hover:border-blue-500 transition-colors"
            >
              <Upload className="w-8 h-8 text-gray-400 mb-2" />
              <div className="text-center">
                <strong className="text-blue-400 hover:underline">
                  Click to upload
                </strong>{" "}
                or drag and drop
                <br />
                PNG, JPG, BMP, TIFF files
              </div>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    if (e.target?.result) {
                      setOriginalImage(e.target.result as string);
                      setProcessedImage(null);
                      setImageInfo(null);
                      setError(null);
                    }
                  };
                  reader.readAsDataURL(file);
                }
              }}
            />
          </div>

          {/* Controls */}
          {originalImage && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Adjustments</h3>

              {error && (
                <div className="bg-red-700 text-white p-3 rounded-md">
                  {error}
                </div>
              )}

              {/* Preview Toggle */}
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className={`flex items-center px-4 py-2 rounded-lg transition-colors ${previewEnabled ? "bg-blue-600 hover:bg-blue-700" : "bg-gray-700 hover:bg-gray-600"}`}
                  onClick={() => setPreviewEnabled(!previewEnabled)}
                >
                  {previewEnabled ? (
                    <Eye className="w-4 h-4 mr-2" />
                  ) : (
                    <EyeOff className="w-4 h-4 mr-2" />
                  )}
                  {previewEnabled ? "Live Preview" : "Preview Off"}
                </button>
              </div>

              {/* Basic Adjustments */}
              <div className="space-y-2">
                <label
                  htmlFor="brightness-slider"
                  className="block text-sm font-medium"
                >
                  Brightness
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="brightness-slider"
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={state.brightness}
                    onChange={(e) =>
                      updateState("brightness", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.brightness.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="contrast-slider"
                  className="block text-sm font-medium"
                >
                  Contrast
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="contrast-slider"
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={state.contrast}
                    onChange={(e) =>
                      updateState("contrast", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.contrast.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="saturation-slider"
                  className="block text-sm font-medium"
                >
                  Saturation
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="saturation-slider"
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={state.saturation}
                    onChange={(e) =>
                      updateState("saturation", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.saturation.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="hue-slider"
                  className="block text-sm font-medium"
                >
                  Hue
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="hue-slider"
                    type="range"
                    min="-180"
                    max="180"
                    step="1"
                    value={state.hue}
                    onChange={(e) =>
                      updateState("hue", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.hue.toFixed(0)}°
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="gamma-slider"
                  className="block text-sm font-medium"
                >
                  Gamma
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="gamma-slider"
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.01"
                    value={state.gamma}
                    onChange={(e) =>
                      updateState("gamma", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.gamma.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Effects */}
              <div className="space-y-2">
                <label
                  htmlFor="blur-slider"
                  className="block text-sm font-medium"
                >
                  Blur
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="blur-slider"
                    type="range"
                    min="0"
                    max="10"
                    step="0.1"
                    value={state.blur}
                    onChange={(e) =>
                      updateState("blur", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.blur.toFixed(1)}px
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="sharpen-slider"
                  className="block text-sm font-medium"
                >
                  Sharpen
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="sharpen-slider"
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={state.sharpen}
                    onChange={(e) =>
                      updateState("sharpen", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.sharpen.toFixed(2)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="noise-slider"
                  className="block text-sm font-medium"
                >
                  Noise
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="noise-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={state.noise}
                    onChange={(e) =>
                      updateState("noise", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.noise.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Transform */}
              <div className="space-y-2">
                <label
                  htmlFor="scale-slider"
                  className="block text-sm font-medium"
                >
                  Scale
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="scale-slider"
                    type="range"
                    min="0.1"
                    max="3"
                    step="0.01"
                    value={state.scale}
                    onChange={(e) =>
                      updateState("scale", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.scale.toFixed(2)}x
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="rotate-slider"
                  className="block text-sm font-medium"
                >
                  Rotate
                </label>
                <div className="flex items-center space-x-3">
                  <input
                    id="rotate-slider"
                    type="range"
                    min="-180"
                    max="180"
                    step="1"
                    value={state.rotate}
                    onChange={(e) =>
                      updateState("rotate", parseFloat(e.target.value))
                    }
                    className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <span className="text-sm w-12 text-right">
                    {state.rotate.toFixed(0)}°
                  </span>
                </div>
              </div>

              {/* White Balance */}
              <div className="space-y-2">
                <label htmlFor="wb-auto" className="block text-sm font-medium">
                  White Balance
                </label>
                <div className="space-y-3">
                  <div className="flex items-center space-x-2">
                    <input
                      id="wb-auto"
                      type="checkbox"
                      checked={state.whiteBalance.auto_adjust}
                      onChange={(e) =>
                        updateWhiteBalance("auto_adjust", e.target.checked)
                      }
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-600 rounded"
                    />
                    <label htmlFor="wb-auto" className="text-sm">
                      Auto Adjust
                    </label>
                  </div>

                  {!state.whiteBalance.auto_adjust && (
                    <>
                      <div className="flex items-center space-x-3">
                        <label
                          htmlFor="wb-temp-slider"
                          className="block text-sm font-medium flex-1"
                        >
                          Temperature
                        </label>
                        <input
                          id="wb-temp-slider"
                          type="range"
                          min="2000"
                          max="10000"
                          step="50"
                          value={state.whiteBalance.temperature}
                          onChange={(e) =>
                            updateWhiteBalance(
                              "temperature",
                              parseFloat(e.target.value),
                            )
                          }
                          className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                        />
                        <span className="text-sm w-16 text-right">
                          {state.whiteBalance.temperature.toFixed(0)}K
                        </span>
                      </div>

                      <div className="flex items-center space-x-3">
                        <label
                          htmlFor="wb-tint-slider"
                          className="block text-sm font-medium flex-1"
                        >
                          Tint
                        </label>
                        <input
                          id="wb-tint-slider"
                          type="range"
                          min="-1"
                          max="1"
                          step="0.01"
                          value={state.whiteBalance.tint}
                          onChange={(e) =>
                            updateWhiteBalance(
                              "tint",
                              parseFloat(e.target.value),
                            )
                          }
                          className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                        />
                        <span className="text-sm w-16 text-right">
                          {state.whiteBalance.tint.toFixed(2)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          {originalImage && (
            <div className="space-y-3">
              <button
                type="button"
                className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                onClick={handleReset}
              >
                <RotateCcw className="w-4 h-4" />
                Reset All
              </button>
              <button
                type="button"
                className="w-full flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 transition-colors"
                onClick={handleExport}
                disabled={!processedImage}
              >
                <Download className="w-4 h-4" />
                Export Image
              </button>
            </div>
          )}
        </aside>

        {/* Main Canvas */}
        <div className="w-3/4 bg-gray-800 p-6 flex flex-col overflow-hidden">
          {originalImage ? (
            <>
              {/* Toolbar */}
              <div className="flex justify-between items-center mb-4 p-3 bg-gray-900 rounded-lg shadow-sm">
                <div className="flex items-center space-x-4">
                  {imageInfo && (
                    <span className="text-sm text-gray-300">
                      {imageInfo.width} × {imageInfo.height}
                    </span>
                  )}
                  {isProcessing && (
                    <div className="flex items-center text-sm text-blue-400">
                      <div className="animate-spin h-4 w-4 mr-2 border-t-2 border-blue-400 rounded-full"></div>
                      Processing...
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    className="p-1 rounded-full hover:bg-gray-700 transition-colors"
                    onClick={() => setZoom(Math.max(25, zoom - 25))}
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-sm font-medium w-10 text-center">
                    {zoom}%
                  </span>
                  <button
                    type="button"
                    className="p-1 rounded-full hover:bg-gray-700 transition-colors"
                    onClick={() => setZoom(Math.min(400, zoom + 25))}
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-md text-sm transition-colors"
                    onClick={() => setZoom(100)}
                  >
                    Fit
                  </button>
                </div>
              </div>

              {/* Image Viewport */}
              <div className="flex-1 overflow-auto bg-black rounded-lg shadow-inner flex items-center justify-center p-4">
                <div className="flex space-x-4 items-stretch h-full w-full">
                  {/* Original Image */}
                  <div className="flex-1 flex flex-col items-center justify-start h-full overflow-hidden">
                    <h4 className="text-lg font-medium mb-2 text-gray-400">
                      Original
                    </h4>
                    <div className="relative flex-1 w-full overflow-hidden cursor-grab active:cursor-grabbing">
                      <img
                        src={originalImage}
                        alt="Original"
                        style={{
                          width: `${zoom}%`,
                          opacity: previewEnabled && processedImage ? 0.7 : 1,
                          transformOrigin: "top left",
                          maxWidth: "none",
                        }}
                        className="block mx-auto"
                      />
                    </div>
                  </div>

                  {/* Processed Image */}
                  {previewEnabled && processedImage && (
                    <div className="flex-1 flex flex-col items-center justify-start h-full overflow-hidden">
                      <h4 className="text-lg font-medium mb-2 text-gray-400">
                        Processed
                      </h4>
                      <div className="relative flex-1 w-full overflow-hidden cursor-grab active:cursor-grabbing">
                        <img
                          src={processedImage}
                          alt="Processed"
                          style={{
                            width: `${zoom}%`,
                            transformOrigin: "top left",
                            maxWidth: "none",
                          }}
                          className="block mx-auto"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* Empty State */
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
              <ImageIcon className="w-16 h-16 text-gray-500 mb-4" />
              <h2 className="text-3xl font-bold text-white mb-3">
                No Image Loaded
              </h2>
              <p className="text-gray-400 text-lg max-w-md">
                Upload an image to start processing.Supported formats: PNG, JPG,
                BMP, TIFF.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
