import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockBridge {
  callbacks: Set<(artboardId: string) => void>;
  tiles: Map<string, { interactive: MockTile | null; final: MockTile | null }>;
  generation: number;
  openImage: ReturnType<typeof vi.fn>;
  prepareImageOpen: ReturnType<typeof vi.fn>;
  restoreCurrentBrowserSnapshot: ReturnType<typeof vi.fn>;
  sendPreviewViewports: ReturnType<typeof vi.fn>;
  pushTile: (artboardId: string, tile: MockTile) => void;
}

interface MockTile {
  image: ImageData;
  x: number;
  y: number;
  width: number;
  height: number;
}

class MockImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace: PredefinedColorSpace;

  constructor(width: number, height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
    this.width = width;
    this.height = height;
    this.colorSpace = "srgb";
  }
}

async function waitForAsyncRefresh() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeMockBridge(): MockBridge {
  const callbacks = new Set<(artboardId: string) => void>();
  const tiles = new Map<string, { interactive: MockTile | null; final: MockTile | null }>();
  const bridge: MockBridge = {
    callbacks,
    tiles,
    generation: 0,
    openImage: vi.fn(async () => ({
      canvas_width: 4000,
      canvas_height: 3000,
      source_bit_depth: "8-bit",
      fingerprint: "fingerprint-1",
    })),
    prepareImageOpen: vi.fn(async () => {}),
    restoreCurrentBrowserSnapshot: vi.fn(async () => false),
    sendPreviewViewports: vi.fn(),
    pushTile(artboardId, tile) {
      tiles.set(artboardId, { interactive: null, final: tile });
      for (const callback of callbacks) callback(artboardId);
    },
  };
  return bridge;
}

async function importOpenImageWithMockBridge(bridge: MockBridge) {
  vi.resetModules();
  vi.doMock("../src/utils", () => ({
    isTauriRuntime: () => true,
    normalizeModifiedAt: (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : null,
    normalizeRating: (value: unknown) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 5
        ? value
        : null,
    normalizeTags: (value: unknown) =>
      Array.isArray(value)
        ? value.filter((tag): tag is string => typeof tag === "string" && tag !== "")
        : [],
  }));
  vi.doMock("../src/data/use-layer-stack", () => ({
    useLayerStack: () => ({ refresh: vi.fn(async () => {}) }),
  }));
  vi.doMock("../src/data/use-image-bridge", () => ({
    useImageBridge: () => ({
      renderPreview: vi.fn(),
      openImage: bridge.openImage,
      prepareImageOpen: bridge.prepareImageOpen,
      openImageFile: vi.fn(),
      openPeerImage: vi.fn(),
      restoreCurrentBrowserSnapshot: bridge.restoreCurrentBrowserSnapshot,
      exportImage: vi.fn(),
      pickExportTarget: vi.fn(),
      setMediaRating: vi.fn(),
      onImageOpenPhase: vi.fn(() => () => {}),
      getArtboardTiles: (artboardId: string) => bridge.tiles.get(artboardId) ?? null,
      nextGeneration: () => {
        bridge.generation += 1;
        return bridge.generation;
      },
      subscribeTiles: (callback: (artboardId: string) => void) => {
        bridge.callbacks.add(callback);
        return () => bridge.callbacks.delete(callback);
      },
      sendPreviewViewports: bridge.sendPreviewViewports,
    }),
  }));
  const [{ useOpenImage }, { state }] = await Promise.all([
    import("../src/store/use-open-image"),
    import("../src/store/editor-store"),
  ]);
  return { image: useOpenImage(), state };
}

describe("useOpenImage native preview requests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("ImageData", MockImageData);
  });

  it("requests preview tiles when the viewport is measured after opening an image", async () => {
    const bridge = makeMockBridge();
    const { image, state } = await importOpenImageWithMockBridge(bridge);

    await image.open("/tmp/photo.tif");

    expect(state.currentView).toBe("editor");
    expect(state.canvasWidth).toBe(4000);
    expect(state.canvasHeight).toBe(3000);
    expect(bridge.sendPreviewViewports).not.toHaveBeenCalled();

    image.setViewportScreenSize(1000, 800);
    await waitForAsyncRefresh();

    expect(bridge.sendPreviewViewports).toHaveBeenCalledTimes(1);
    expect(bridge.sendPreviewViewports).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quality: "final",
        viewports: expect.arrayContaining([
          expect.objectContaining({
            artboard_id: "primary:preview",
            target_width: expect.any(Number),
            target_height: expect.any(Number),
          }),
        ]),
      }),
    );
  });

  it("requests preview tiles when an image opens after the viewport is measured", async () => {
    const bridge = makeMockBridge();
    const { image } = await importOpenImageWithMockBridge(bridge);

    image.setViewportScreenSize(1000, 800);
    await image.open("/tmp/photo.tif");

    expect(bridge.sendPreviewViewports).toHaveBeenCalledTimes(1);
    expect(bridge.sendPreviewViewports).toHaveBeenLastCalledWith(
      expect.objectContaining({
        quality: "final",
        viewports: expect.arrayContaining([
          expect.objectContaining({ artboard_id: "primary:preview" }),
        ]),
      }),
    );
  });

  it("applies pushed preview tiles to the editor state", async () => {
    const bridge = makeMockBridge();
    const { image, state } = await importOpenImageWithMockBridge(bridge);

    await image.open("/tmp/photo.tif");
    image.setViewportScreenSize(1000, 800);
    await waitForAsyncRefresh();
    bridge.pushTile("primary:preview", {
      image: new ImageData(128, 96),
      x: 0,
      y: 0,
      width: 4000,
      height: 3000,
    });

    expect(image.previewTile()).not.toBeNull();
    expect(state.previewRenderWidth).toBe(128);
    expect(state.previewRenderHeight).toBe(96);
    expect(state.previewDisplayColorSpace).toBe("sRGB");
  });
});
