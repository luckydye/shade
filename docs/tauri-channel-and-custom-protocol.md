# Revised Plan: Tauri Channel + Custom Protocol IPC

## Core Principles

```text
invoke()
  = commands / mutations

channels
  = invalidation / progress / coordination

custom protocol
  = all binary transport
```

The architecture intentionally separates:

* control plane
* notification plane
* binary/image transport

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
start_preview_session
save_preset
start_library_scan
```

Commands return immediately whenever possible.

---

## Channels

Used ONLY for:

* invalidation
* progress
* lightweight metadata
* state coordination

Never:

* image bytes
* thumbnails
* RGBA buffers
* binary payloads

Typical messages are tiny JSON objects.

---

## Custom Protocol (`shade://`)

Used for ALL binary/image transport.

Examples:

```text
shade://preview/<session>/current
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
  channel_protocol.rs
  channel_server.rs
  preview_protocol.rs
  commands.rs
  lib.rs
```

---

# Channel Protocol

```rust
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChannelMessage {
    // Preview
    PreviewInvalidated {
        session_id: String,
        generation: u64,
    },

    // Library
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

    // Thumbnail
    ThumbnailReady {
        path: String,
        cache_key: String,
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

* messages are metadata only
* no image payloads
* no sequence-based frame streaming

---

# Preview Protocol

## URI Structure

```text
shade://preview/<session>/current
shade://thumb/<cache_key>
```

No frame sequence numbers.

The preview system is state-driven, not frame-driven.

---

# Preview Rendering Model

## Before

```text
apply_edit
  ↓
render_preview
  ↓
return image bytes
```

---

## After

```text
apply_edit
  ↓
render worker updates current preview
  ↓
channel.send(PreviewInvalidated)
  ↓
frontend reloads current preview URL
```

---

# Frontend Preview Flow

## Frontend

```ts
channel.onPreviewInvalidated((msg) => {
  img.src =
    `shade://preview/${msg.session_id}/current?g=${msg.generation}`;
});
```

The query parameter only exists to force refresh semantics.

The actual preview state is always:

```text
/current
```

This removes:

* frame bookkeeping
* stale frame accumulation
* sequence synchronization
* preview queue complexity

---

# Preview Cache

The preview cache stores:

* compressed previews
* JPEG/WebP
* never raw RGBA unless explicitly required

Recommended:

```text
JPEG for interactive previews
WebP for higher quality previews
```

Avoid:

```text
Vec<u8> RGBA framebuffer caches
```

for memory reasons.

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

* preview responses
* thumbnail responses
* cache lookup
* content type headers
* browser cache control

The protocol handler should return proper MIME types:

```text
image/jpeg
image/webp
image/png
```

---

# Thumbnail Flow

## Before

```text
invoke("get_thumbnail")
  → Vec<u8>
```

This serializes through IPC.

Bad.

---

## After

```text
invoke("request_thumbnail")
```

Backend:

```text
generate thumbnail
  ↓
store in thumbnail cache
  ↓
send ThumbnailReady(cache_key)
```

Frontend:

```html
<img src="shade://thumb/<cache_key>">
```

The browser handles:

* decode
* cache
* scheduling

natively.

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
onPreviewInvalidated(cb)
onLibraryScanProgress(cb)
onBatchProgress(cb)
```

---

# `preview.ts`

Responsibilities:

* preview refresh logic
* cache-busting generation handling
* image element coordination
* bitmap upload helpers later

---

# Memory Strategy

## Preview Cache

Bounded LRU.

Recommended:

```text
2–4 active previews max
```

Store compressed previews only.

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

* channel protocol
* channel registration
* frontend dispatcher
* managed channel state
* protocol registration

---

## Phase 1 — Preview Pipeline

* preview protocol
* compressed preview cache
* `PreviewInvalidated`
* frontend preview refresh
* remove blocking preview round-trip

---

## Phase 2 — Thumbnails

* thumbnail cache
* `shade://thumb/`
* thumbnail invalidation
* browser-native image loading

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

## Channels are NOT a streaming transport

They are:

```text
coordination transport
```

not:

```text
media transport
```

---

## Previews are stateful

Not sequential frame streams.

This is closer to how:

* Lightroom
* Capture One
* Figma

style rendering systems behave.

---

## Browser image pipeline is leveraged intentionally

The browser/WebView is already highly optimized for:

* image decode
* caching
* texture upload

The architecture should use that rather than fighting it with manual JS blob management.

---

# Escape Hatch

If later measurements show:

* protocol latency too high
* preview invalidation too slow
* decode bottlenecks

then the system can still migrate preview transport to:

* WebSocket
* shared textures
* GPU-native rendering

without changing:

* command APIs
* channel protocol
* frontend coordination logic

Only the binary transport layer changes.
