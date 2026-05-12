# Revised Plan: Tauri Channel + Custom Protocol IPC

## Core Principles

```text
invoke()
  = commands / mutations

coordination channel  (JS → Rust + Rust → JS)
  = viewport state updates / invalidation / progress / metadata

preview channel  (Rust → JS)
  = pixel frame stream (push, per-artboard)

custom protocol (shade://)
  = thumbnails / static binary assets
```

The architecture intentionally separates:

* control plane
* coordination/notification plane
* preview pixel stream (push)
* static binary transport

This avoids pushing image data through the WebView IPC bridge while still keeping the system fully inside Tauri.

---

# Goals

The system should:

* eliminate large JSON payloads
* avoid WebSocket infrastructure
* support reactive UI updates
* support efficient preview rendering
* support future GPU-backed rendering
* preserve browser (`shade-web`) compatibility

---

# Transport Rules

## `invoke()`

Used for:

* mutations
* requests
* configuration
* session creation
* edit operations

Examples:

```text
apply_edit
save_preset
start_library_scan
```

Commands return immediately whenever possible.

---

## Coordination Channel

Bidirectional (JS → Rust and Rust → JS).

JS → Rust:

* viewport state updates (`update_preview_viewports`)

Rust → JS:

* invalidation
* progress
* lightweight metadata
* state coordination

Viewport updates go through the channel — not invoke() — because they fire
rapidly during pan, zoom, and drag. Fire-and-forget semantics mean the
frontend never blocks waiting for a response.

Never carries:

* image bytes
* thumbnails
* RGBA buffers
* binary payloads

Typical messages are tiny JSON objects.

---

## Preview Channel

A dedicated Tauri `Channel<PreviewFrame>` separate from the coordination
channel. Unlike the coordination channel, this IS a binary streaming
transport — Rust pushes pixel frames to it as renders complete.

Each frame carries:

```rust
struct PreviewFrame {
    artboard_id: String,
    generation: u64,      // matches generation from viewport update — stale frames discarded
    quality: "interactive" | "final",
    width: u32,
    height: u32,
    crop_x: f64,
    crop_y: f64,
    crop_width: f64,
    crop_height: f64,
    kind: "rgba" | "rgba-float16",
    color_space: "srgb" | "display-p3",
    pixels: Vec<u8>,
}
```

The preview channel is the only channel that carries binary payloads. The
coordination channel remains metadata-only.

---

## Custom Protocol (`shade://`)

Used for binary/image transport.

Examples:

```text
shade://thumb/<cache_key>
```

The browser/WebView image pipeline handles:

* caching
* decoding
* scheduling
* texture upload

This avoids JS-side blob churn and unnecessary allocations.

---

# Architecture

## Rust Side

```text
shade-tauri/src/
  channel_protocol.rs   — coordination channel messages
  channel_server.rs
  preview_channel.rs    — preview frame push channel  (renamed from preview_protocol.rs)
  preview_scheduler.rs  — multi-artboard render queue  (new)
  commands.rs
  lib.rs
```

---

# Channel Protocol

```rust
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChannelMessage {
    // Preview viewport state (JS → Rust)
    UpdatePreviewViewports {
        generation: u64,
        quality: PreviewQuality,
        viewports: Vec<ArtboardViewport>,
    },

    // Library (Rust → JS)
    LibraryScanProgress {
        library_id: String,
        scanned: u64,
        total: u64,
    },

    LibraryScanComplete {
        library_id: String,
    },

    LibraryListChunk {
        request_id: u32,
        items: Vec<LibraryImageListing>,
        done: bool,
    },

    // Thumbnail (Rust → JS)
    // Sent when Rust has proactively re-rendered a thumbnail (e.g. after save
    // or library scan). Frontend updates its <img> src to the new fingerprint.
    ThumbnailReady {
        path: String,
        edit_fingerprint: String,
    },

    // Batch
    BatchExportProgress {
        current: u32,
        total: u32,
        name: String,
        error: Option<String>,
    },

    // Peer
    PeerPaired {
        peer_id: String,
        name: String,
    },

    PeerAwarenessUpdate {
        peer_id: String,
        state: AwarenessState,
    },

    // Collections / Presets
    CollectionChanged {
        collection_id: String,
    },

    PresetListChanged,
}
```

Important:

* JS → Rust messages: viewport state updates
* Rust → JS messages: library progress, batch progress, peer events, thumbnail ready
* no image payloads in either direction on this channel
* preview frames go through the dedicated preview channel (`Channel<PreviewFrame>`)

---

# Preview Protocol

## Transport

Live preview pixel data is pushed from Rust to the frontend via the dedicated
**preview channel** — a `Channel<PreviewFrame>` separate from the coordination
channel.

The custom protocol handles thumbnails only:

```text
shade://thumb/<cache_key>
```

## Viewport State Sync

The frontend sends viewport state as a channel message whenever the viewport
changes (pan / zoom / crop / artboard set):

```rust
// JS → Rust, sent over the coordination channel
UpdatePreviewViewports {
    generation: u64,     // monotonically increasing, frontend-assigned
    quality: "interactive" | "final",
    viewports: Vec<ArtboardViewport>,
}

struct ArtboardViewport {
    artboard_id: String,
    crop: PreviewCrop,       // visible region in artboard-local coords
    target_width: u32,       // pixel dimensions to render
    target_height: u32,
    priority: u32,           // 0 = selected, 1+ = background
}
```

This is a channel message rather than an invoke() call because viewport
updates fire rapidly during pan, zoom, and drag — invoke() would queue up
round-trips and add latency.

The `quality` hint comes from the frontend because only the frontend knows
whether a UI interaction (slider drag) is in progress.

## Rust Render Worker Behaviour

1. On `update_preview_viewports`: cancel in-flight renders for changed
   artboards, re-queue by priority.
2. Render each artboard in priority order (selected first, background
   opportunistically).
3. Push a `PreviewFrame` to the preview channel as each artboard completes.

## Why a channel (not invoke()) for previews

The viewport renders tiles directly onto a `<canvas>` using `putImageData` +
`drawImage`. It also samples raw pixel values for the tone picker and the
brush mask overlay. These operations require a live `ImageData` handle —
not a browser-decoded `<img>` element.

The push model lets Rust schedule and prioritise renders across multiple
artboards independently of the frontend. Background artboards render
opportunistically without the frontend polling.

---

# Preview Rendering Model

```text
apply_edit  /  pan  /  zoom  /  artboard change
  ↓
channel.send(UpdatePreviewViewports { generation, quality, viewports })
  ↓
Rust cancels stale renders, re-queues by priority
  ↓
[per artboard, in priority order]
  render → raw pixel buffer: float16 Display P3 | RGBA u8
  ↓
  preview_channel.send(PreviewFrame { artboard_id, generation, ... })
  ↓
frontend: stale-check → ImageData → RenderedTile signal
  ↓
compositor: putImageData → drawImage onto <canvas>
```

---

# Frontend Preview Flow

## Viewport state updates

```ts
// called on every pan / zoom / crop / artboard-set change
// fire-and-forget via coordination channel — not invoke()
coordinationChannel.send({
  type: "update_preview_viewports",
  generation: ++currentGeneration,
  quality: isInteracting ? "interactive" : "final",
  viewports: buildViewports(),
});
```

## Preview channel handler

```ts
previewChannel.onFrame((frame) => {
  if (frame.generation < currentGeneration) return; // stale
  const tile = toRenderedTile(frame);
  setArtboardTile(frame.artboard_id, frame.quality, tile);
});
```

`toRenderedTile()` converts the raw pixel buffer to `ImageData`:

```ts
type PreviewFrame = {
  artboard_id: string;
  generation: number;
  quality: "interactive" | "final";
  kind: "rgba" | "rgba-float16";
  color_space: "srgb" | "display-p3";
  pixels: Uint8Array;         // raw bytes (float16 if kind === "rgba-float16")
  width: number;
  height: number;
  crop_x: number;
  crop_y: number;
  crop_width: number;
  crop_height: number;
};
```

The resulting `RenderedTile` is stored in a per-artboard tile map. The canvas
re-renders reactively whenever the signal changes.

The compositor renders by showing the `final` tile if available, falling back
to `interactive`, falling back to the last cached backdrop.

---

# Preview Cache

Preview tiles are **raw pixel data held in JS memory** — not encoded images.

Each tile is an `ImageData` (8-bit RGBA or float16 Display P3) wrapped in a
`RenderedTile`:

```ts
interface RenderedTile {
  image: ImageData;   // raw pixels — never encoded
  x: number;         // artboard-local position
  y: number;
  width: number;     // world-space extent
  height: number;
}
```

Tiles are stored in a per-artboard map with two quality slots:

```ts
// keyed by artboard_id
Map<string, { interactive: RenderedTile | null, final: RenderedTile | null }>
```

The push model eliminates snapshot-equality logic: Rust drives invalidation and
the generation counter discards stale frames, so the frontend never needs to
compare viewport snapshots. There is no Rust-side encoded image cache.

Avoid:

```text
JPEG / WebP / PNG encoded buffers in the preview path
  — lossy formats lose photo fidelity
  — lossless PNG can't represent float16 Display P3
  — encoding/decoding adds latency with no benefit

Vec<u8> RGBA framebuffer caches on the Rust side
  — unbounded memory, wrong layer for this cache
```

The `OffscreenCanvas` surface cache in the compositor avoids redundant
`putImageData` calls between frames.

---

# Channel Server

## Responsibilities

* register frontend channel
* store active channel handle
* expose lightweight send helpers
* gracefully handle disconnects

Workers do:

```rust
if let Some(ch) = channel.read().await.as_ref() {
    let _ = ch.send(msg);
}
```

No worker should ever panic because the frontend reloaded.

---

# Custom Protocol Handler

```rust
tauri::Builder::default()
    .register_uri_scheme_protocol("shade", ...)
```

Responsibilities:

* thumbnail responses
* cache lookup
* content type headers
* browser cache control

Preview pixel data does **not** go through this handler — it is pushed via
the preview channel (`Channel<PreviewFrame>`).

The protocol handler should return proper MIME types:

```text
image/png
```

---

# Thumbnail Flow

```html
<img src="shade://thumb/<path>?edit=<fingerprint>">
```

The edit fingerprint is a hash or generation counter that changes whenever
the edit stack for that image changes. It is part of the browser cache key,
so a new fingerprint forces a fresh fetch without any explicit cache
invalidation.

The protocol handler uses `(path, fingerprint)` as its cache key:

* cache hit → return cached bytes immediately
* cache miss → render thumbnail with current edits → cache → return

## Keeping the fingerprint current

**Frontend-driven** (normal case): the frontend already knows when edits
change because it is the one applying them. It updates the `<img>` src with
the new fingerprint immediately.

**Rust-driven** (background re-render): after a save or library scan Rust
may proactively re-render thumbnails. It sends `ThumbnailReady` over the
coordination channel so the frontend can update its src:

```ts
onThumbnailReady(({ path, edit_fingerprint }) => {
  setThumbnailSrc(path, `shade://thumb/${path}?edit=${edit_fingerprint}`);
});
```

The browser handles decode, HTTP cache, and scheduling natively.

---

# Library Streaming

## Before

```text
invoke(list_library_images)
  → huge JSON payload
```

---

## After

```text
invoke(list_library_images_stream)
```

Backend streams chunks:

```text
LibraryListChunk
```

Frontend progressively appends items.

This prevents:

* giant allocations
* UI stalls
* long IPC blocking

---

# Batch Operations

## Flow

```text
invoke(batch_export_images)
```

Backend sends:

```text
BatchExportProgress
```

Important:

Ordering is guaranteed only per worker/task.

There is no global ordering guarantee across unrelated async workers.

---

# Frontend Structure

```text
shade-ui/src/bridge/
  index.ts
  channel.ts
  preview.ts
```

---

# `channel.ts`

Responsibilities:

* register Tauri channel
* dispatch incoming messages
* expose subscribe APIs

Example:

```ts
onLibraryScanProgress(cb)
onBatchProgress(cb)
onThumbnailReady(cb)
```

---

# `preview.ts`

Responsibilities:

* register and own the preview channel (`Channel<PreviewFrame>`)
* maintain `currentGeneration` counter; increment on each viewport update
* send `UpdatePreviewViewports` over the coordination channel on viewport changes
* receive pushed `PreviewFrame` objects; discard stale frames by generation
* convert frames to `RenderedTile` and update per-artboard tile map signals
* expose per-artboard tile signals to the compositor

---

# Memory Strategy

## Preview Cache — Multi-Artboard Tile Map

Per-artboard tile map, two quality slots each:

```text
Map<artboard_id, { interactive: RenderedTile | null, final: RenderedTile | null }>
```

Both quality levels are `RenderedTile` signals (raw `ImageData`). Tiles are set
directly when a `PreviewFrame` arrives from Rust; no snapshot-equality comparison
is needed.

Compositor render order per artboard:

```text
1. final tile if available
2. fall back to interactive tile
3. fall back to last cached backdrop
```

Each tile also has a corresponding `OffscreenCanvas` surface cached in the
compositor to avoid redundant `putImageData` calls.

Quality levels:

```text
interactive — lower resolution, issued during slider drag / pan / zoom
final       — full resolution, issued when interaction settles
```

Priority:

```text
0 — selected artboard (rendered first)
1+ — background artboards (rendered opportunistically)
```

---

## Thumbnail Cache

Bounded LRU.

Recommended:

```text
256–512 entries
```

---

# Implementation Phases

## Phase 0 — Infrastructure

* coordination channel protocol
* coordination channel registration and frontend dispatcher
* managed channel state
* preview channel registration (`Channel<PreviewFrame>`)
* `preview_channel.rs` — frame type and push helpers
* `preview_scheduler.rs` — multi-artboard render queue skeleton
* protocol registration (`shade://`)

---

## Phase 1 — Preview Pipeline (push model)

* `UpdatePreviewViewports` channel message — viewport state sync (fire-and-forget)
* `preview_scheduler.rs` — priority queue, cancellation, per-artboard workers
* Rust pushes `PreviewFrame` to preview channel as renders complete
* frontend: generation counter, stale-frame discard
* per-artboard tile map (`Map<artboard_id, { interactive, final }>`)
* compositor: final → interactive → backdrop fallback chain
* interactive + final quality levels driven from frontend interaction state

---

## Phase 2 — Thumbnails

* thumbnail cache (Rust-side, keyed by `(path, edit_fingerprint)`)
* `shade://thumb/<path>?edit=<fingerprint>` protocol handler — on-demand render + cache serve
* `ThumbnailReady` — Rust notifies frontend after background re-renders
* browser-native image loading; fingerprint in URL drives cache invalidation

---

## Phase 3 — Streaming Library APIs

* chunked library list streaming
* scan progress
* progressive UI population

---

## Phase 4 — Batch / Peer / Collections

* replace `app.emit()`
* unify coordination plane under channels

---

## Phase 5 — Cleanup

* remove legacy events
* remove binary IPC returns
* document protocol

---

# Important Design Constraints

## The coordination channel is NOT a streaming transport

The coordination channel carries metadata only (tiny JSON):

```text
coordination transport — invalidation, progress, state events
```

not:

```text
media transport — pixel buffers, binary payloads
```

The **preview channel** is a separate `Channel<PreviewFrame>` that IS a
binary streaming transport. Keeping them separate means the coordination
channel latency is never affected by preview frame size or volume.

---

## Multi-artboard scheduling

Rust owns render scheduling and prioritisation:

* selected artboard → priority 0, rendered first
* background artboards → priority 1+, rendered opportunistically
* viewport updates cancel and re-queue in-flight renders
* generation counter lets the frontend discard frames that arrived after a
  newer viewport update superseded them

The frontend does not poll. It sends viewport state and receives pushed frames.

---

## Browser image pipeline is leveraged for thumbnails only

For thumbnails (`shade://thumb/<cache_key>`) the browser handles:

* image decode
* HTTP cache
* texture upload

This is appropriate for thumbnails because they are static, cacheable by
key, and do not require direct pixel access.

Live previews cannot use this path. The viewport needs raw `ImageData`
for:

* direct pixel sampling (tone picker reads `tile.image.data` per pointer event)
* brush mask overlay (`stampBrushOverlay` writes into a pixel buffer)
* float16 Display P3 wide-gamut support (not representable in PNG or any
  format that browsers decode to sRGB `ImageData` by default)
