/**
 * shade-web worker entry point.
 *
 * Receives `MutationRequest` / `ReadRequest` envelopes from the main thread
 * over `postMessage` and dispatches each to a handler. Results / notifications
 * are emitted back to main as `ChannelMessage` envelopes.
 *
 * This worker is the web equivalent of the Rust-side dispatch_mutation /
 * dispatch_read endpoints. It speaks the exact same protocol; only the
 * transport (postMessage vs Tauri invoke) differs.
 *
 * NOTE: image-processing operations that need the wasm renderer
 * (apply_edit, render_preview, add_layer, etc.) currently throw — those
 * require integrating the wasm worker and will land in a follow-up. Data
 * ops backed by IndexedDB (presets, snapshots, ratings, collections) are
 * implemented here using the existing browser-*-platform modules.
 */

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
  postMessage(msg: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
};

interface MutationEnvelope {
  kind: "mutation";
  request: MutationRequest;
}

interface ReadEnvelope {
  kind: "read";
  readId: number;
  request: ReadRequest;
}

type Envelope = MutationEnvelope | ReadEnvelope;

function send(msg: ChannelMessage) {
  self.postMessage(msg);
}

function notImplemented(name: string): never {
  throw new Error(`shade-web worker: ${name} not yet supported`);
}

async function handleMutation(request: MutationRequest): Promise<void> {
  switch (request.type) {
    // ── Presets (IndexedDB) ─────────────────────────────────────────────
    case "save_preset":
    case "save_preset_from_json":
    case "rename_preset":
    case "delete_preset": {
      switch (request.type) {
        case "save_preset":
          // Web savePreset needs the current stack — that requires editor
          // state which lives in the wasm worker. Defer until wasm wired.
          notImplemented("save_preset");
          break;
        case "save_preset_from_json": {
          const data = JSON.parse(request.json);
          await browserPresetsPlatform.savePreset(request.name, data);
          break;
        }
        case "rename_preset":
          await browserPresetsPlatform.renamePreset(
            request.old_name,
            request.new_name,
          );
          break;
        case "delete_preset":
          await browserPresetsPlatform.deletePreset(request.name);
          break;
      }
      send({ type: "preset_list_changed" });
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
      send({
        type: "collection_changed",
        collection_id: request.collection_id,
      });
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
      send({
        type: "collection_changed",
        collection_id: request.collection_id,
      });
      return;
    case "remove_from_collection":
      await browserCollectionsPlatform.removeFromCollection(
        request.collection_id,
        request.fingerprints,
      );
      send({
        type: "collection_changed",
        collection_id: request.collection_id,
      });
      return;
    // ── Media metadata (IndexedDB) ──────────────────────────────────────
    case "set_media_rating":
      await browserRatingsPlatform.setRating(
        request.fingerprint,
        request.rating,
      );
      send({
        type: "media_metadata_changed",
        fingerprints: [request.fingerprint],
      });
      return;
    case "set_media_tags":
      // Browser tags aren't persisted yet — fire the notification anyway.
      send({
        type: "media_metadata_changed",
        fingerprints: [request.fingerprint],
      });
      return;
    // ── Snapshots ──────────────────────────────────────────────────────
    case "save_snapshot":
      notImplemented("save_snapshot (needs wasm-side stack snapshot)");
      break;
    case "load_snapshot":
      notImplemented("load_snapshot (needs wasm-side stack replace)");
      break;
    // ── Wasm-backed editor mutations ───────────────────────────────────
    case "add_layer":
    case "delete_layer":
    case "move_layer":
    case "set_layer_visible":
    case "set_layer_opacity":
    case "rename_layer":
    case "replace_stack":
    case "apply_edit":
    case "apply_gradient_mask":
    case "remove_mask":
    case "create_brush_mask":
    case "stamp_brush_mask":
    case "load_preset":
    case "apply_preset_snapshot":
      notImplemented(`${request.type} (wasm worker integration pending)`);
      break;
    // ── Library config / peer / batch / camera (Tauri-only) ─────────────
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

async function handleRead(
  readId: number,
  request: ReadRequest,
): Promise<void> {
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
      case "list_library_images": {
        // Streaming response — emit chunked ReadResponse messages.
        // For the browser, we don't have a library lister wired up here yet;
        // emit a single empty chunk with done=true.
        send({
          type: "read_response",
          read_id: readId,
          kind: "library_images_chunk",
          value: [],
          done: true,
        });
        return;
      }
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
        value = await browserCollectionsPlatform.listCollections(
          request.library_id,
        );
        break;
      case "list_collection_items":
        kind = "collection_items";
        value = await browserCollectionsPlatform.listCollectionItems(
          request.collection_id,
        );
        break;
      case "get_preset_json": {
        const preset = await browserPresetsPlatform.loadPreset(request.name);
        kind = "preset_json";
        value = JSON.stringify(preset);
        break;
      }
      case "get_snapshot_preset_json":
      case "list_peer_pictures":
      case "get_local_peer_discovery_snapshot":
      case "get_s3_media_library":
      case "get_peer_awareness":
      case "get_stack_snapshot":
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

self.onmessage = (event: MessageEvent<unknown>) => {
  const env = event.data as Envelope;
  if (env.kind === "mutation") {
    handleMutation(env.request).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[shade-web worker] mutation failed", err);
    });
  } else if (env.kind === "read") {
    void handleRead(env.readId, env.request);
  } else {
    // eslint-disable-next-line no-console
    console.error("[shade-web worker] unknown envelope", env);
  }
};
