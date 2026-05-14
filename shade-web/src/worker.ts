/**
 * shade-web worker entry point.
 *
 * Hosts the wasm renderer and dispatches both message protocols:
 *
 *   * Legacy `{ type, requestId, ... }` messages — emitted by the existing
 *     `workerCall` path in shade-ui/bridge/index.ts for the few lifecycle
 *     calls that haven't joined the unified protocol yet (open_image,
 *     export_image, render_preview, render_snapshot_thumbnail, get_stack).
 *   * Unified `{ kind: "mutation" | "read", request, ... }` envelopes — the
 *     web equivalent of Rust's dispatch_mutation / dispatch_read endpoints.
 *
 * Both flow into the same wasm instance so editor state remains consistent.
 * Results / notifications for the unified protocol go out as `ChannelMessage`
 * objects via postMessage; the legacy protocol keeps its existing
 * `{ type: "X_applied", requestId }` shape.
 */

import init, * as wasm from "shade-wasm";
import { browserCollectionsPlatform } from "./browser-collections-platform";
import { browserPresetsPlatform } from "./browser-presets-platform";
import { browserRatingsPlatform } from "./browser-ratings-platform";
import { browserSnapshotsPlatform } from "./browser-snapshots-platform";
import type {
  ChannelMessage,
  MutationRequest,
  ReadRequest,
} from "shade-ui/src/bridge/channel";

declare const self: {
  postMessage(msg: unknown, transferOrOptions?: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};

// ── wasm init ────────────────────────────────────────────────────────────────

let initPromise: Promise<void> | null = null;
let rendererPromise: Promise<void> | null = null;

function ensureWasmReady(): Promise<void> {
  if (initPromise) return initPromise;
  const p = init()
    .then(() => {
      self.postMessage({ type: "ready" });
    })
    .catch((error: unknown) => {
      initPromise = null;
      throw error;
    });
  initPromise = p;
  return p;
}

function ensureRendererReady(): Promise<void> {
  if (rendererPromise) return rendererPromise;
  const p = ensureWasmReady()
    .then(() => wasm.init_renderer())
    .then(() => undefined)
    .catch((error: unknown) => {
      rendererPromise = null;
      throw error;
    });
  rendererPromise = p;
  return p;
}

function isRecoverableGpuError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("async map a buffer") ||
    message.includes("createBuffer failed") ||
    message.includes("device lost") ||
    message.includes("GPUDevice")
  );
}

async function retryWithFreshRenderer<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isRecoverableGpuError(error)) throw error;
    rendererPromise = null;
    wasm.reset_renderer();
    await ensureRendererReady();
    return action();
  }
}

// ── Unified protocol helpers ────────────────────────────────────────────────

function send(msg: ChannelMessage) {
  self.postMessage(msg);
}

function broadcastLayerStack() {
  try {
    const json = wasm.get_stack_json();
    const stack = JSON.parse(json);
    send({ type: "layer_stack_snapshot", stack });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[shade-web worker] failed to broadcast stack", err);
  }
}

function applyEditOp(params: Record<string, unknown> & { layer_idx: number; op: string }) {
  const idx = params.layer_idx;
  switch (params.op) {
    case "crop":
      wasm.apply_crop(
        idx,
        params.crop_x as number,
        params.crop_y as number,
        params.crop_width as number,
        params.crop_height as number,
        (params.crop_rotation as number | undefined) ?? 0,
      );
      return;
    case "tone":
      wasm.apply_tone(
        idx,
        params.exposure as number,
        params.contrast as number,
        params.blacks as number,
        (params.whites as number | undefined) ?? 0,
        params.highlights as number,
        params.shadows as number,
        (params.gamma as number | undefined) ?? 1,
      );
      return;
    case "color":
      wasm.apply_color(
        idx,
        params.saturation as number,
        params.vibrancy as number,
        params.temperature as number,
        params.tint as number,
      );
      return;
    case "hsl":
      wasm.apply_hsl(
        idx,
        (params.red_hue as number | undefined) ?? 0,
        (params.red_sat as number | undefined) ?? 0,
        (params.red_lum as number | undefined) ?? 0,
        (params.green_hue as number | undefined) ?? 0,
        (params.green_sat as number | undefined) ?? 0,
        (params.green_lum as number | undefined) ?? 0,
        (params.blue_hue as number | undefined) ?? 0,
        (params.blue_sat as number | undefined) ?? 0,
        (params.blue_lum as number | undefined) ?? 0,
      );
      return;
    case "curves":
      wasm.apply_curves(idx, (params.curve_points as unknown[] | undefined) ?? []);
      return;
    case "ls_curve":
      wasm.apply_ls_curve(idx, (params.curve_points as unknown[] | undefined) ?? []);
      return;
    case "vignette":
      wasm.apply_vignette(idx, (params.vignette_amount as number | undefined) ?? 0);
      return;
    case "sharpen":
      wasm.apply_sharpen(idx, (params.sharpen_amount as number | undefined) ?? 0);
      return;
    case "grain":
      wasm.apply_grain(
        idx,
        (params.grain_amount as number | undefined) ?? 0,
        (params.grain_size as number | undefined) ?? 1,
      );
      return;
    case "glow":
      wasm.apply_glow(idx, (params.glow_amount as number | undefined) ?? 0);
      return;
    case "denoise":
      wasm.apply_denoise(
        idx,
        (params.denoise_luma_strength as number | undefined) ?? 0,
        (params.denoise_chroma_strength as number | undefined) ?? 0,
        (params.denoise_mode as number | undefined) ?? 0,
      );
      return;
    default:
      throw new Error(`unsupported edit op: ${String(params.op)}`);
  }
}

async function handleMutation(request: MutationRequest): Promise<void> {
  await ensureWasmReady();
  switch (request.type) {
    // ── Layer structure (wasm) ──────────────────────────────────────────
    case "add_layer":
      wasm.add_layer(request.kind);
      broadcastLayerStack();
      return;
    case "delete_layer":
      wasm.delete_layer(request.idx);
      broadcastLayerStack();
      return;
    case "move_layer":
      wasm.move_layer(request.from, request.to);
      broadcastLayerStack();
      return;
    case "set_layer_visible":
      wasm.set_layer_visible(request.idx, request.visible);
      broadcastLayerStack();
      return;
    case "set_layer_opacity":
      wasm.set_layer_opacity(request.idx, request.opacity);
      broadcastLayerStack();
      return;
    case "rename_layer":
      wasm.rename_layer(request.idx, request.name);
      broadcastLayerStack();
      return;
    case "replace_stack":
      wasm.replace_stack_json(request.layers_json);
      broadcastLayerStack();
      return;
    // ── Adjustments / crop (wasm) ───────────────────────────────────────
    case "apply_edit":
      applyEditOp(request as unknown as Record<string, unknown> & {
        layer_idx: number;
        op: string;
      });
      broadcastLayerStack();
      return;
    // ── Masks (wasm) ────────────────────────────────────────────────────
    case "apply_gradient_mask": {
      const p = request as unknown as Record<string, unknown> & {
        layer_idx: number;
        kind: string;
      };
      if (p.kind === "linear") {
        wasm.apply_linear_gradient_mask(
          p.layer_idx,
          p.x1 as number,
          p.y1 as number,
          p.x2 as number,
          p.y2 as number,
        );
      } else {
        wasm.apply_radial_gradient_mask(
          p.layer_idx,
          p.cx as number,
          p.cy as number,
          p.radius as number,
        );
      }
      broadcastLayerStack();
      return;
    }
    case "remove_mask":
      wasm.remove_mask(request.idx);
      broadcastLayerStack();
      return;
    case "create_brush_mask":
      wasm.create_brush_mask(request.idx);
      broadcastLayerStack();
      return;
    case "stamp_brush_mask": {
      const p = request as unknown as Record<string, unknown> & {
        layer_idx: number;
        cx: number;
        cy: number;
        radius: number;
        softness: number;
        erase: boolean;
      };
      wasm.stamp_brush_mask(p.layer_idx, p.cx, p.cy, p.radius, p.softness, p.erase);
      // Mask params don't change shape — no snapshot broadcast.
      return;
    }
    // ── Presets / snapshots (combine IndexedDB + wasm) ─────────────────
    case "save_preset": {
      const stackJson = wasm.get_stack_json();
      const stack = JSON.parse(stackJson) as {
        layers: { kind: string }[];
      };
      const presetLayers = stack.layers.filter((l) => l.kind !== "image");
      await browserPresetsPlatform.savePreset(request.name, {
        version: 1,
        layers: presetLayers as never,
      });
      send({ type: "preset_list_changed" });
      return;
    }
    case "save_preset_from_json": {
      const data = JSON.parse(request.json);
      await browserPresetsPlatform.savePreset(request.name, data);
      send({ type: "preset_list_changed" });
      return;
    }
    case "rename_preset":
      await browserPresetsPlatform.renamePreset(request.old_name, request.new_name);
      send({ type: "preset_list_changed" });
      return;
    case "delete_preset":
      await browserPresetsPlatform.deletePreset(request.name);
      send({ type: "preset_list_changed" });
      return;
    case "load_preset": {
      const preset = await browserPresetsPlatform.loadPreset(request.name);
      // Replace non-image layers with the preset's layers, keep image layers.
      const stackJson = wasm.get_stack_json();
      const stack = JSON.parse(stackJson) as {
        layers: { kind: string }[];
        canvas_width: number;
        canvas_height: number;
      };
      const imageLayers = stack.layers.filter((l) => l.kind === "image");
      const newStack = {
        layers: [...imageLayers, ...preset.layers],
        canvas_width: stack.canvas_width,
        canvas_height: stack.canvas_height,
      };
      wasm.replace_stack_json(JSON.stringify(newStack));
      broadcastLayerStack();
      return;
    }
    case "apply_preset_snapshot": {
      const preset = await browserPresetsPlatform.loadPreset(request.name);
      const stackJson = wasm.get_stack_json();
      const stack = JSON.parse(stackJson) as {
        layers: { kind: string }[];
        canvas_width: number;
        canvas_height: number;
      };
      const imageLayers = stack.layers.filter((l) => l.kind === "image");
      wasm.replace_stack_json(
        JSON.stringify({
          layers: [...imageLayers, ...preset.layers],
          canvas_width: stack.canvas_width,
          canvas_height: stack.canvas_height,
        }),
      );
      broadcastLayerStack();
      const info = await browserSnapshotsPlatform.saveSnapshot(preset.layers, null);
      send({ type: "snapshot_saved", fingerprint: null, id: info.id });
      return;
    }
    case "save_snapshot": {
      const stackJson = wasm.get_stack_json();
      const stack = JSON.parse(stackJson) as { layers: { kind: string }[] };
      const nonImage = stack.layers.filter((l) => l.kind !== "image");
      const info = await browserSnapshotsPlatform.saveSnapshot(
        nonImage as never,
        null,
      );
      send({ type: "snapshot_saved", fingerprint: null, id: info.id });
      return;
    }
    case "load_snapshot": {
      const record = await browserSnapshotsPlatform.getSnapshot(request.id);
      if (!record) throw new Error(`snapshot not found: ${request.id}`);
      const stackJson = wasm.get_stack_json();
      const stack = JSON.parse(stackJson) as {
        layers: { kind: string }[];
        canvas_width: number;
        canvas_height: number;
      };
      const imageLayers = stack.layers.filter((l) => l.kind === "image");
      wasm.replace_stack_json(
        JSON.stringify({
          layers: [...imageLayers, ...record.layers],
          canvas_width: stack.canvas_width,
          canvas_height: stack.canvas_height,
        }),
      );
      broadcastLayerStack();
      return;
    }
    // ── Collections (IndexedDB) ─────────────────────────────────────────
    case "create_collection": {
      const collection = await browserCollectionsPlatform.createCollection(
        request.library_id,
        request.name,
      );
      send({ type: "collection_created", collection });
      send({ type: "collection_list_changed" });
      return;
    }
    case "rename_collection":
      await browserCollectionsPlatform.renameCollection(
        request.collection_id,
        request.name,
      );
      send({ type: "collection_changed", collection_id: request.collection_id });
      return;
    case "delete_collection":
      await browserCollectionsPlatform.deleteCollection(request.collection_id);
      send({ type: "collection_list_changed" });
      return;
    case "reorder_collection":
      await browserCollectionsPlatform.reorderCollection(
        request.collection_id,
        request.new_position,
      );
      send({ type: "collection_list_changed" });
      return;
    case "add_to_collection":
      await browserCollectionsPlatform.addToCollection(
        request.collection_id,
        request.fingerprints,
      );
      send({ type: "collection_changed", collection_id: request.collection_id });
      return;
    case "remove_from_collection":
      await browserCollectionsPlatform.removeFromCollection(
        request.collection_id,
        request.fingerprints,
      );
      send({ type: "collection_changed", collection_id: request.collection_id });
      return;
    // ── Media metadata (IndexedDB) ──────────────────────────────────────
    case "set_media_rating":
      await browserRatingsPlatform.setRating(request.fingerprint, request.rating);
      send({ type: "media_metadata_changed", fingerprints: [request.fingerprint] });
      return;
    case "set_media_tags":
      send({ type: "media_metadata_changed", fingerprints: [request.fingerprint] });
      return;
    // ── Tauri-only ──────────────────────────────────────────────────────
    case "set_media_library_order":
    case "set_library_mode":
    case "sync_library":
    case "refresh_library_index":
    case "delete_media_library_item":
    case "remove_media_library":
    case "upload_media_library_url":
    case "upload_media_library_file":
    case "upload_media_library_path":
    case "add_media_library":
    case "add_s3_media_library":
    case "update_s3_media_library":
    case "batch_apply_preset_snapshot":
    case "batch_clear_edits":
    case "batch_export_images":
    case "apply_peer_metadata":
    case "pair_peer_device":
    case "set_local_awareness":
      throw new Error(
        `shade-web worker: ${request.type} is not supported in the web build`,
      );
    default: {
      const exhaustive: never = request;
      void exhaustive;
      throw new Error(`shade-web worker: unhandled mutation type`);
    }
  }
}

async function handleRead(readId: number, request: ReadRequest): Promise<void> {
  try {
    let kind: string;
    let value: unknown;
    switch (request.type) {
      case "list_pictures":
        kind = "pictures";
        value = [];
        break;
      case "list_media_libraries":
        kind = "media_libraries";
        value = [];
        break;
      case "list_library_images":
        send({
          type: "read_response",
          read_id: readId,
          kind: "library_images_chunk",
          value: [],
          done: true,
        });
        return;
      case "list_media_ratings":
        kind = "media_ratings";
        value = await browserRatingsPlatform.listRatings(request.fingerprints);
        break;
      case "list_presets":
        kind = "presets";
        value = await browserPresetsPlatform.listPresets();
        break;
      case "list_snapshots":
        kind = "snapshots";
        value = await browserSnapshotsPlatform.listSnapshots(null);
        break;
      case "list_collections":
        kind = "collections";
        value = await browserCollectionsPlatform.listCollections(request.library_id);
        break;
      case "list_collection_items":
        kind = "collection_items";
        value = await browserCollectionsPlatform.listCollectionItems(
          request.collection_id,
        );
        break;
      case "get_preset_json": {
        await ensureWasmReady();
        const preset = await browserPresetsPlatform.loadPreset(request.name);
        kind = "preset_json";
        value = JSON.stringify(preset);
        break;
      }
      case "get_snapshot_preset_json": {
        const snapshot = await browserSnapshotsPlatform.getCurrentSnapshot("");
        kind = "snapshot_preset_json";
        value = snapshot
          ? JSON.stringify({ version: 1, layers: snapshot.layers })
          : null;
        break;
      }
      case "get_stack_snapshot": {
        await ensureWasmReady();
        kind = "stack_snapshot";
        value = wasm.get_stack_snapshot_json();
        break;
      }
      case "list_peer_pictures":
      case "get_local_peer_discovery_snapshot":
      case "get_s3_media_library":
      case "get_peer_awareness":
      case "sync_peer_snapshots":
        throw new Error(
          `shade-web worker: ${request.type} is not supported in the web build`,
        );
      default: {
        const exhaustive: never = request;
        void exhaustive;
        throw new Error(`shade-web worker: unhandled read type`);
      }
    }
    send({ type: "read_response", read_id: readId, kind, value, done: true });
  } catch (err) {
    send({
      type: "read_failed",
      read_id: readId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Legacy protocol — kept for lifecycle ops that haven't joined the
//    unified Transport yet (open_image, render_preview, etc.).
async function handleLegacy(msg: Record<string, unknown>): Promise<void> {
  const requestId =
    typeof msg.requestId === "number" ? (msg.requestId as number) : undefined;
  try {
    switch (msg.type) {
      case "init":
        await ensureWasmReady();
        break;
      case "load_image_encoded": {
        await ensureWasmReady();
        if (!(msg.bytes instanceof ArrayBuffer)) {
          throw new Error("load_image_encoded expects ArrayBuffer payload");
        }
        const info = await wasm.load_image_encoded(
          new Uint8Array(msg.bytes),
          (msg.fileName as string | null) ?? null,
        );
        self.postMessage({
          type: "image_loaded",
          requestId,
          layerCount: info.layer_count,
          canvasWidth: info.canvas_width,
          canvasHeight: info.canvas_height,
          source_bit_depth: info.source_bit_depth,
        });
        break;
      }
      case "get_stack": {
        await ensureWasmReady();
        self.postMessage({ type: "stack", requestId, data: wasm.get_stack_json() });
        break;
      }
      case "render_snapshot_thumbnail": {
        await ensureWasmReady();
        if (!(msg.bytes instanceof ArrayBuffer)) {
          throw new Error("render_snapshot_thumbnail expects ArrayBuffer");
        }
        const frame = await retryWithFreshRenderer(async () => {
          await ensureRendererReady();
          return (
            wasm as unknown as {
              render_snapshot_thumbnail: (
                bytes: Uint8Array,
                fileName: string | null,
                layersJson: string,
                targetWidth: number,
                targetHeight: number,
              ) => Promise<{ pixels: Uint8Array | number[]; width: number; height: number }>;
            }
          ).render_snapshot_thumbnail(
            new Uint8Array(msg.bytes as ArrayBuffer),
            (msg.fileName as string | null) ?? null,
            (msg.layersJson as string) ?? '{"layers":[]}',
            (msg.targetWidth as number) ?? 320,
            (msg.targetHeight as number) ?? 320,
          );
        });
        const pixels =
          frame.pixels instanceof Uint8Array
            ? frame.pixels
            : Uint8Array.from(frame.pixels);
        self.postMessage(
          {
            type: "snapshot_thumbnail_rendered",
            requestId,
            pixels,
            width: frame.width,
            height: frame.height,
          },
          { transfer: [pixels.buffer] },
        );
        break;
      }
      case "render_preview": {
        const frame = await retryWithFreshRenderer(async () => {
          await ensureRendererReady();
          return wasm.render_preview_rgba(
            (msg.request as unknown) ?? null,
          );
        });
        const pixels =
          frame.pixels instanceof Uint8Array
            ? frame.pixels
            : Uint8Array.from(frame.pixels);
        self.postMessage(
          {
            type: "preview_rendered",
            requestId,
            pixels,
            width: frame.width,
            height: frame.height,
          },
          { transfer: [pixels.buffer] },
        );
        break;
      }
      default:
        throw new Error(`unsupported legacy worker message: ${String(msg.type)}`);
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = (event: MessageEvent<unknown>) => {
  const data = event.data as Record<string, unknown>;
  // Unified protocol envelopes have `kind: "mutation" | "read"`.
  if (data.kind === "mutation") {
    handleMutation(data.request as MutationRequest).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[shade-web worker] mutation failed", err);
    });
    return;
  }
  if (data.kind === "read") {
    void handleRead(data.readId as number, data.request as ReadRequest);
    return;
  }
  // Otherwise it's a legacy `{ type, requestId, ... }` message.
  void handleLegacy(data);
};
