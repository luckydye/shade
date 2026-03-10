# Shade — Cross-Platform GPU Photo Editor

## 1. Vision & Goals

Build a performant, cross-platform photo editor whose image processing pipeline runs entirely on the GPU via **wgpu**. The same Rust core compiles to:

- **Native CLI** — batch processing, scripting, headless servers.
- **Native desktop app** — via a web-technology UI shell (Tauri or Electron-style wrapper).
- **Web app** — wgpu compiled to WASM/WebGPU, UI rendered in the browser.

All three targets share a single Rust processing library; only the thin UI and I/O layers differ.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│                   UI Layer (Web Tech)                │
│   React / Svelte / Solid — HTML/CSS/JS              │
│   Canvas viewport  │  Layer panel  │  Tool panel     │
└────────────────────────┬────────────────────────────┘
                         │  Commands (JSON / MessagePack)
                         ▼
┌─────────────────────────────────────────────────────┐
│               Bridge / FFI Layer                     │
│  Native: Tauri command bridge (IPC)                  │
│  Web:    wasm-bindgen + JS glue                      │
│  CLI:    clap argument parser → direct Rust calls    │
└────────────────────────┬────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│            Core Engine  (Rust crate)                 │
│                                                      │
│  ┌───────────┐  ┌────────────┐  ┌────────────────┐  │
│  │ Edit Graph │  │ Layer Stack│  │ Mask System    │  │
│  │ (DAG)      │  │            │  │ (brush, grad)  │  │
│  └─────┬──────┘  └─────┬──────┘  └──────┬─────────┘  │
│        └───────┬───────┘               │            │
│                ▼                       │            │
│  ┌─────────────────────────────┐      │            │
│  │   GPU Pipeline (wgpu)       │◄─────┘            │
│  │   Compute & Render passes   │                   │
│  │   WGSL shaders              │                   │
│  └─────────────┬───────────────┘                   │
│                │                                    │
│  ┌─────────────▼───────────────┐                   │
│  │   I/O & Color Management    │                   │
│  │   image crate, lcms2, exif  │                   │
│  └─────────────────────────────┘                   │
└─────────────────────────────────────────────────────┘
```

### Component Summary

| Component | Responsibility |
|---|---|
| **UI Layer** | All user interaction — panels, sliders, brush input, viewport. Pure web tech. |
| **Bridge** | Serialises commands between UI and engine. Tauri IPC (native) or wasm-bindgen (web). |
| **Edit Graph** | Directed acyclic graph of operations. Tracks dependencies, enables caching and lazy re-evaluation. |
| **Layer Stack** | Ordered collection of image layers and adjustment layers, each with blend mode, opacity, and optional mask. |
| **Mask System** | Per-layer mask stored as a single-channel GPU texture. Updated by brush strokes or procedural generators. |
| **GPU Pipeline** | All pixel work: adjustment shaders, convolutions, compositing, viewport rendering. |
| **I/O & Color** | Decode/encode (JPEG, PNG, TIFF, RAW via `rawloader`), ICC profile handling, EXIF preservation. |

---

## 3. Rust Crate Structure

```
shade/
├── crates/
│   ├── shade-core/           # Edit graph, layer model, mask model, project serialisation
│   ├── shade-gpu/            # wgpu device management, shader compilation, pipeline cache
│   ├── shade-shaders/        # WGSL shader source files (build-time validated)
│   ├── shade-io/             # Image decode/encode, RAW, ICC, EXIF
│   ├── shade-cli/            # CLI binary (clap)
│   ├── shade-wasm/           # wasm-bindgen entry point for browser target
│   └── shade-tauri/          # Tauri app shell + IPC command handlers
├── ui/                       # Web frontend (Vite + framework of choice)
│   ├── src/
│   ├── public/
│   └── package.json
├── shaders/                  # Shared WGSL shaders (symlinked or copied at build)
└── Cargo.toml                # Workspace root
```

### Key crate details

**`shade-gpu`** owns the `wgpu::Device` and `Queue`. It exposes a `Renderer` that accepts an edit graph snapshot and produces a final composited texture. Internally it maintains a **pipeline cache** (keyed by shader + bind-group layout) and a **texture cache** (keyed by node ID + parameter hash) so only dirty nodes re-execute.

**`shade-core`** is deliberately GPU-agnostic — it describes *what* to compute, not *how*. This makes it easy to unit-test on CPU and to serialise projects to disk.

---

## 4. GPU Pipeline Design

### 4.1 Execution Model

Every edit operation is a **compute shader dispatch** or a **full-screen fragment pass**, operating on GPU textures. The engine never downloads pixels back to the CPU during editing — only at final export.

```
Source Texture (decoded image, uploaded once)
        │
        ▼
 ┌──────────────────────────────────────────┐
 │  Per-adjustment-layer pipeline:           │
 │                                           │
 │   Adjustment compute dispatch             │
 │        ↓                                  │
 │   Mask sample (brush texture)             │
 │        ↓                                  │
 │   Blend with layer below (mix by mask×α)  │
 └──────────────────────────────────────────┘
        │  ... repeat for each layer ...
        ▼
 ┌──────────────────────────────────────────┐
 │  Global post-process:                     │
 │   Crop/transform → Sharpen → Grain        │
 │        ↓                                  │
 │   Viewport tone-map + zoom/pan            │
 └──────────────────────────────────────────┘
        │
        ▼
   Surface / export texture
```

### 4.2 Texture & Buffer Strategy

| Resource | Format | Notes |
|---|---|---|
| Source image | `Rgba32Float` or `Rgba16Float` | Per-layer bit depth. 32-bit for RAW / HDR sources or layers needing headroom; 16-bit for lighter adjustments. |
| Intermediate layer results | Matches each layer's bit depth | Ping-pong between two textures per layer. Compositor handles mixed-precision blending (see §6.3). |
| Mask textures | `R8Unorm` | One per masked layer. Updated incrementally by brush strokes. |
| LUT / Curves | `storage buffer` or 1D texture | 1024-entry float32 lookup for 32-bit layers, 256-entry for 16-bit; rebuilt when curve control points change. |
| Uniform buffers | Per-dispatch | Small structs: exposure, contrast, temperature, vignette params, etc. Always `f32`. |

### 4.3 Caching & Dirty Tracking

Each node in the edit graph carries a **generation counter**. When a parameter changes, only that node and its descendants are marked dirty. The renderer walks the DAG top-down, skipping clean nodes whose cached output textures are still valid. This means dragging a single slider only re-dispatches one or two shader passes, keeping interaction fluid.

---

## 5. WGSL Shader Catalogue

All shaders live in `shaders/` as `.wgsl` files, validated at build time via `naga`.

### 5.1 Exposure / Contrast / Black-Level / Highlights-Shadows

A single unified **tone** compute shader:

```wgsl
// shaders/tone.wgsl  (simplified excerpt)

struct ToneParams {
    exposure: f32,      // EV stops, applied as 2^exposure multiplier
    contrast: f32,      // pivot around mid-grey
    blacks: f32,        // lift / crush
    highlights: f32,    // roll-off compression
    shadows: f32,       // lift in low end
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: ToneParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(input_tex);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }

    var c = textureLoad(input_tex, vec2<i32>(gid.xy), 0);

    // Exposure
    c = vec4(c.rgb * pow(2.0, params.exposure), c.a);

    // Contrast (S-curve around 0.18 mid-grey)
    let mid = vec3(0.18);
    c = vec4(mid + (c.rgb - mid) * (1.0 + params.contrast), c.a);

    // Black level (simple lift)
    c = vec4(max(c.rgb + vec3(params.blacks), vec3(0.0)), c.a);

    // ... highlights / shadows via soft-knee curves ...

    textureStore(output_tex, vec2<i32>(gid.xy), c);
}
```

### 5.2 Curves

User-editable curve → baked into a **256-entry float LUT** stored in a storage buffer. The shader does a simple LUT lookup with linear interpolation, applied per-channel or to luminance.

```wgsl
@group(0) @binding(2) var<storage, read> lut_r: array<f32, 256>;
@group(0) @binding(3) var<storage, read> lut_g: array<f32, 256>;
@group(0) @binding(4) var<storage, read> lut_b: array<f32, 256>;

fn apply_curve(val: f32, lut: ptr<storage, array<f32, 256>, read>) -> f32 {
    let idx = clamp(val * 255.0, 0.0, 255.0);
    let lo = u32(floor(idx));
    let hi = min(lo + 1u, 255u);
    let frac = idx - floor(idx);
    return mix((*lut)[lo], (*lut)[hi], frac);
}
```

### 5.3 Color Adjustments (Saturation, Vibrancy, Temperature)

```wgsl
struct ColorParams {
    saturation: f32,    // 0 = mono, 1 = unchanged, >1 = boost
    vibrancy: f32,      // selective saturation (less-saturated pixels boosted more)
    temperature: f32,   // Kelvin shift mapped to blue–yellow axis
    tint: f32,          // green–magenta axis
};
```

Vibrancy uses the pixel's existing saturation as a weighting factor — low-saturation pixels get a stronger boost, preventing already-vivid regions from clipping. Temperature and tint are applied as multipliers in a linear RGB space before any tone curve.

### 5.4 Vignette

Radial distance from centre, parameterised by amount, midpoint, roundness, feather. Computed analytically per-pixel — no texture needed.

```wgsl
fn vignette(uv: vec2<f32>, params: VignetteParams) -> f32 {
    let centered = (uv - 0.5) * vec2(params.roundness, 1.0);
    let dist = length(centered);
    let v = smoothstep(params.midpoint - params.feather,
                       params.midpoint + params.feather, dist);
    return 1.0 - v * params.amount;
}
```

### 5.5 Sharpen (Unsharp Mask)

Two-pass Gaussian blur (horizontal + vertical compute dispatches), then `sharpened = original + amount * (original - blurred)`. A threshold parameter suppresses sharpening in smooth regions to avoid noise amplification.

### 5.6 Grain

Film grain synthesised from a hash-based noise function (no texture fetch needed), mixed in luminance space. Parameters: amount, size (controls downscale factor of noise), roughness.

### 5.7 Crop & Horizon (Geometric Transform)

A single fragment shader that samples the source through an affine matrix (rotation + translation + scale). Bilinear or Lanczos interpolation selectable. The crop rectangle is encoded as the output viewport dimensions; no pixels outside it are ever computed.

### 5.8 Layer Compositing

```wgsl
fn composite(base: vec4<f32>, layer: vec4<f32>, mask: f32,
             opacity: f32, blend_mode: u32) -> vec4<f32> {
    let blended = apply_blend(base.rgb, layer.rgb, blend_mode);
    let alpha = mask * opacity;
    return vec4(mix(base.rgb, blended, alpha), base.a);
}
```

`apply_blend` implements Normal, Multiply, Screen, Overlay, Soft Light, and Luminosity as a `switch` on `blend_mode`.

---

## 6. Layer & Mask System

### 6.1 Layer Model

```rust
enum Layer {
    Image {
        texture_id: TextureId,
        transform: AffineTransform,
    },
    Adjustment {
        ops: Vec<AdjustmentOp>,   // tone, curves, color, vignette, sharpen, grain
    },
}

#[derive(Clone, Copy, Default)]
enum LayerPrecision {
    #[default]
    Half,   // Rgba16Float — 8 bytes/pixel
    Full,   // Rgba32Float — 16 bytes/pixel
}

struct LayerEntry {
    layer: Layer,
    precision: LayerPrecision,  // per-layer bit depth
    blend_mode: BlendMode,
    opacity: f32,
    mask: Option<MaskId>,
    visible: bool,
}
```

### 6.3 Mixed-Precision Compositing

Layers can freely mix 16-bit and 32-bit textures within the same stack. The compositor handles this transparently:

**Rule**: compositing always happens at the **higher** precision of the two inputs. When a 16-bit layer is blended onto a 32-bit accumulator (or vice-versa), the lower-precision texture is sampled and implicitly promoted to `f32` by the GPU — this is free in hardware since the shader ALU operates in `f32` regardless. The output texture format of each composite step matches the higher of the two inputs.

```
Layer 3 (16-bit, Saturation tweak)
    ↓ composite at 32-bit (because accumulator below is 32-bit)
Layer 2 (32-bit, Heavy exposure recovery)
    ↓ composite at 32-bit
Layer 1 (16-bit, Base image)  →  promoted to 32-bit for this blend
    ↓
Accumulator: 32-bit
```

In practice this means the accumulator "upgrades" to 32-bit the moment it encounters any 32-bit layer, and stays there. If the entire stack is 16-bit, compositing stays 16-bit throughout — no wasted VRAM.

The compositor shader selects bind group layouts at dispatch time based on each layer pair's precision combination. Four variants are pre-compiled:

| Base | Layer | Output | Notes |
|---|---|---|---|
| 16-bit | 16-bit | 16-bit | Fast path, lowest VRAM |
| 16-bit | 32-bit | 32-bit | Base promoted in-shader |
| 32-bit | 16-bit | 32-bit | Layer promoted in-shader |
| 32-bit | 32-bit | 32-bit | Full precision path |

**Default heuristic**: When a user adds a new layer, the app defaults to 16-bit. Image layers sourced from 32-bit EXR/HDR files default to 32-bit. The user can override either way via the layer panel. A tooltip shows per-layer VRAM usage so the cost is visible.

### 6.2 Brush Mask Editing

Brush strokes are received from the UI as a stream of `(x, y, pressure, timestamp)` samples. On the Rust side these are interpolated into a smooth polyline with Catmull-Rom splines, then **rasterised directly into the mask texture** via a small compute dispatch that stamps a soft circular brush footprint at each interpolated point.

Because only the affected rectangular region of the mask is updated per stroke segment, incremental painting is cheap — typically a few hundred pixels wide.

The UI sends strokes via a **streaming channel** (not request/response) so there is zero perceptible latency between pen movement and mask update.

---

## 7. Edit Graph (DAG)

```
[Source Image]
      │
      ▼
[Adjustment Layer 1: Exposure +0.5, Contrast +10]──▶[Mask 1 (brush)]
      │
      ▼
[Image Layer 2: texture overlay]──────────────────▶[Mask 2 (gradient)]
      │
      ▼
[Adjustment Layer 3: Curves, Saturation]
      │
      ▼
[Global Post: Crop → Sharpen → Grain]
      │
      ▼
[Composite Output]
```

Each node stores its parameter hash and a `generation: u64`. The renderer diff-checks generations to skip clean sub-trees. This is critical: when the user tweaks a single slider on layer 3, layers 1 and 2 don't re-render.

---

## 8. Cross-Platform Targets

### 8.1 Native Desktop (Tauri)

```
┌──────────────────────────────┐
│  Tauri webview (system)      │  ← renders the UI
│  ┌────────────────────────┐  │
│  │  <canvas> viewport     │──┼──── wgpu surface presented directly
│  └────────────────────────┘  │     to a native window region
│                              │
│  Rust backend (same process) │  ← shade-core + shade-gpu
└──────────────────────────────┘
```

The viewport `<canvas>` is backed by a **raw window handle** that wgpu renders into directly — the composited image never passes through JS. UI overlays (crop handles, brush cursor) are drawn in an HTML layer on top.

Tauri commands are async Rust functions annotated with `#[tauri::command]`; the UI calls them via `invoke()`.

### 8.2 Web (WASM + WebGPU)

```
┌────────────────────────────────────────┐
│  Browser tab                           │
│  ┌──────────────────────────────────┐  │
│  │  Same UI code (React/Svelte)     │  │
│  │  <canvas id="viewport">          │──┼── WebGPU context
│  └──────────────────────────────────┘  │
│                                        │
│  photon_wasm.js  (wasm-bindgen glue)   │
│  photon_wasm_bg.wasm                   │
└────────────────────────────────────────┘
```

`shade-wasm` is compiled with `--target web`. wgpu's WebGPU backend maps directly to the browser's `navigator.gpu`. The WASM module is loaded in a **Web Worker** to keep the UI thread free; the viewport canvas is transferred to the worker via `OffscreenCanvas`.

**Fallback**: if WebGPU is unavailable, the app can display a clear message. Optionally, a reduced-feature CPU path using `wgpu`'s WebGL2 backend could be provided, but at lower performance.

### 8.3 CLI

```bash
shade edit input.jpg \
  --exposure +1.2 \
  --contrast 15 \
  --curves curves.json \
  --saturation 1.1 \
  --temperature 5800 \
  --sharpen 0.6 \
  --grain 0.2 \
  --crop 16:9 \
  --output result.tiff

shade batch edits.json ./photos/ --output ./processed/
```

The CLI binary links `shade-core` and `shade-gpu` directly. It creates a headless wgpu device (`instance.request_adapter` with `power_preference: HighPerformance` and no surface), runs the full pipeline, reads back the final texture, and encodes to the output format. Perfect for batch workflows and CI pipelines.

---

## 9. UI Design

### 9.1 Tech Stack

| Concern | Choice | Rationale |
|---|---|---|
| Framework | **SolidJS** (or React) | Fine-grained reactivity maps well to slider-heavy UI; small bundle. |
| Styling | **Tailwind CSS** | Rapid iteration, dark-theme friendly utility classes. |
| State | **Zustand** (or Solid stores) | Lightweight, works well with undo/redo middleware. |
| Canvas | **HTML `<canvas>`** | wgpu renders directly into it; UI overlays sit in positioned HTML above. |
| Bundler | **Vite** | Fast HMR, WASM plugin support. |

### 9.2 Layout

```
┌───────────────────────────────────────────────────────────────┐
│ Toolbar:  Open │ Save │ Export │ Undo │ Redo │ Zoom │ Fit     │
├────────┬──────────────────────────────────────┬───────────────┤
│        │                                      │               │
│ Layer  │         Canvas Viewport              │  Inspector    │
│ Panel  │                                      │               │
│        │   (GPU-rendered, pan/zoom)           │  - Tone       │
│ ┌────┐ │                                      │  - Curves     │
│ │ L3 │ │                                      │  - Color      │
│ ├────┤ │                                      │  - Vignette   │
│ │ L2 │ │                                      │  - Sharpen    │
│ ├────┤ │                                      │  - Grain      │
│ │ L1 │ │                                      │  - Crop       │
│ └────┘ │                                      │               │
│ + Add  │                                      │  Mask tools   │
│        │                                      │  (brush,      │
│        │                                      │   erase,      │
│        │                                      │   gradient)   │
├────────┴──────────────────────────────────────┴───────────────┤
│ Status bar:  Zoom 100%  │  4000×2667  │  VRAM: 768 MB  │  sRGB     │
└───────────────────────────────────────────────────────────────┘
```

### 9.3 UI ↔ Engine Communication Protocol

Commands are plain JSON objects sent over the bridge:

```jsonc
// Slider change
{ "cmd": "set_param", "layer": 0, "op": "tone", "field": "exposure", "value": 1.2 }

// Brush stroke segment (high frequency, batched per frame)
{ "cmd": "brush", "layer": 1, "points": [[x,y,pressure], ...], "size": 40, "hardness": 0.7 }

// Layer operations
{ "cmd": "add_layer", "kind": "adjustment" }
{ "cmd": "reorder_layers", "order": [2, 0, 1] }

// Export
{ "cmd": "export", "format": "tiff", "bit_depth": 16, "color_space": "AdobeRGB" }
```

The engine acknowledges each command and, when the viewport texture is updated, signals the UI to
present the new frame.

---

## 10. Project File Format

Projects are saved as a **single `.shade` file** (a ZIP archive):

```
project.shade (ZIP)
├── manifest.json        # version, canvas size, color space, bit depth (16 or 32)
├── layers.json          # layer stack: order, params, blend modes, opacity
├── curves/              # curve control points per layer
│   └── layer_0.json
├── masks/
│   ├── layer_1.png      # mask bitmaps (lossless 8-bit grey)
│   └── layer_2.png
├── images/
│   ├── source.original  # original file bytes (lossless embed)
│   └── overlay_1.png    # image layers
└── history.json         # optional: undo stack for session restore
```

This keeps projects self-contained, versionable, and inspectable with any ZIP tool.

The `.shade` extension is registered with the OS on install so double-clicking opens the project directly.

---

## 11. Performance Considerations

**Texture residency**: Keep all active layer textures resident on GPU. Per-layer precision means VRAM scales with actual need: a 24 MP 16-bit layer ≈ 192 MB, a 32-bit layer ≈ 384 MB. A typical project with one 32-bit base image and two 16-bit adjustment layers uses ~768 MB rather than the ~1.5 GB an all-32-bit stack would require. For constrained hardware: offer a project-wide "force 16-bit" toggle, implement texture tiling for very large images, and drop to half-res preview textures during interactive slider drags.

**Slider interactivity target**: < 8 ms from parameter change to new frame (120 fps capable). Achieved because a single adjustment re-dispatch on a 24 MP texture takes ~1–2 ms on mid-range GPUs.

**Brush latency**: Stroke points are streamed to the engine at display refresh rate. Mask updates are partial (only the dirty rect), keeping each update under 0.5 ms.

**WASM considerations**: WebGPU dispatch overhead is slightly higher due to JS↔WASM boundary crossings. Mitigate by batching parameter updates per frame and avoiding per-pixel round-trips.

**Startup**: Pre-compile all shader pipelines in a background task at launch. Cache compiled pipelines to disk (native) or IndexedDB (web) using wgpu's pipeline cache API.

---

## 12. Development Phases

### Phase 1 — Foundation (Weeks 1–6)

- Set up Rust workspace, wgpu device initialisation (native + WASM).
- Implement image decode/encode (`image` crate, basic RAW via `rawloader`).
- Build the tone shader (exposure, contrast, blacks).
- Minimal CLI: load image → apply tone → export.
- Scaffold the Tauri app shell with a blank canvas that displays a GPU-rendered image.

### Phase 2 — Core Editing (Weeks 7–12)

- Curves (LUT bake + shader).
- Color adjustments (saturation, vibrancy, temperature, tint).
- Vignette, sharpen (two-pass Gaussian + USM), grain.
- Crop and horizon rotation with bilinear sampling.
- Build the inspector panel UI with sliders wired to Tauri commands.

### Phase 3 — Layers & Masks (Weeks 13–18)

- Layer stack model and compositor shader.
- Adjustment layers with per-layer parameter sets.
- Image layers (upload, transform, blend modes).
- Brush mask rasteriser (compute shader stamp).
- Brush / eraser / gradient mask tools in UI.
- Layer panel UI (reorder via drag, visibility toggle, opacity slider).

### Phase 4 — Web Target (Weeks 19–22)

- Compile `shade-wasm` with wasm-pack, integrate into Vite.
- OffscreenCanvas worker architecture.
- Adapt UI bridge from Tauri IPC to wasm-bindgen calls.
- Test on Chrome and Firefox (WebGPU availability).
- Optimise WASM bundle size (wasm-opt, tree-shaking).

### Phase 5 — Polish & Ship (Weeks 23–28)

- Undo/redo (command pattern on the edit graph).
- Project save/load (`.photon` ZIP format).
- Keyboard shortcuts, pan/zoom gestures.
- ICC colour management (display profile aware rendering).
- Performance profiling and shader optimisation.
- CI: automated tests (CPU reference renders vs GPU output, tolerance-based).
- Package: Tauri installers (macOS .dmg, Windows .msi, Linux .AppImage), npm publish for web, crates.io for CLI.

---

## 13. Testing Strategy

**Shader correctness**: A CPU reference implementation (`shade-core` with a `CpuBackend` trait) produces expected output for each operation. GPU output is compared per-pixel with a tolerance (±1 in 16-bit) to catch driver-specific rounding.

**Integration tests**: The CLI is invoked with known input images and parameter sets; outputs are compared against golden reference files.

**UI tests**: Playwright tests drive the web UI — open image, adjust slider, verify the canvas updated (screenshot diff).

**Fuzz testing**: `cargo-fuzz` on the project file parser and image decoders to catch panics on malformed input.

---

## 14. Key Dependencies

| Crate | Purpose |
|---|---|
| `wgpu` | GPU abstraction (Vulkan, Metal, DX12, WebGPU) |
| `naga` | WGSL shader validation at build time |
| `image` | Decode/encode JPEG, PNG, TIFF, BMP, WebP |
| `rawloader` | Camera RAW decode |
| `lcms2` | ICC colour management |
| `kamadak-exif` | EXIF read/write |
| `tauri` | Native desktop shell |
| `wasm-bindgen` | Rust ↔ JS bridge for WASM |
| `clap` | CLI argument parsing |
| `serde` / `serde_json` | Serialisation for project files and IPC |
| `zip` | Project file archive |
| `rayon` | CPU parallelism for image decode and non-GPU tasks |

---

## 15. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WebGPU browser support still incomplete | Web target limited to Chrome/Edge | Detect at runtime; show clear fallback message. Consider WebGL2 backend for basics. |
| VRAM pressure on integrated GPUs | Lag or OOM on large images | Implement tiled rendering; degrade to half-res preview during slider drag. |
| wgpu WASM bundle size | Slow first load on web | Use `wasm-opt -Oz`, lazy-load non-critical shaders, aggressive code splitting. |
| Brush latency over IPC | Perceptible lag painting masks | Stream points via shared memory (native) or `SharedArrayBuffer` (web). |
| Colour accuracy across platforms | Inconsistent output | Ship with a reference test suite; convert to linear sRGB internally, apply display profile only at viewport. |
