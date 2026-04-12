import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const baseUrl = process.env.BENCH_BASE_URL;
if (!baseUrl) {
  throw new Error("BENCH_BASE_URL missing");
}

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const fixtures = [
  {
    key: "jpg",
    path: "/test/fixtures/IMG_20260310_115134692.jpg",
    name: "IMG_20260310_115134692.jpg",
  },
  {
    key: "cr3",
    path: "/test/fixtures/_MGC3030.CR3",
    name: "_MGC3030.CR3",
  },
];
const repetitions = 3;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function waitForDebugPort(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`chrome devtools port ${port} did not open`);
}

function createRpc(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== "number") {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message ?? String(message.error)));
      return;
    }
    entry.resolve(message.result);
  };
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

async function benchOnce(fixture, index) {
  const port = 9222 + index;
  const chromeProcess = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      `--remote-debugging-port=${port}`,
      `${baseUrl}/autoresearch/wasm-bench/blank.html`,
    ],
    { stdio: "ignore" },
  );

  let ws;
  try {
    await waitForDebugPort(port);
    const targetResponse = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${baseUrl}/autoresearch/wasm-bench/blank.html`)}`,
      { method: "PUT" },
    );
    const target = await targetResponse.json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("failed to open devtools websocket"));
    });
    const rpc = createRpc(ws);
    await rpc("Runtime.enable");
    const moduleUrl = new URL("/shade-wasm/pkg/shade_wasm.js", baseUrl).toString();
    const fixtureUrl = new URL(fixture.path, baseUrl).toString();
    const expression = `
      (async () => {
        const mod = await import(${JSON.stringify(moduleUrl)});
        const initWasm = mod.default;
        const wasm = mod;
        const fetchResponse = await fetch(${JSON.stringify(fixtureUrl)}, { cache: "no-store" });
        if (!fetchResponse.ok) {
          throw new Error(\`failed to fetch fixture: \${fetchResponse.status}\`);
        }
        const bytes = new Uint8Array(await fetchResponse.arrayBuffer());
        const wasmInitStart = performance.now();
        await initWasm();
        const wasmInitMs = performance.now() - wasmInitStart;
        const rendererInitStart = performance.now();
        await wasm.init_renderer();
        const rendererInitMs = performance.now() - rendererInitStart;
        const decodeStart = performance.now();
        const info = wasm.load_image_encoded(bytes, ${JSON.stringify(fixture.name)});
        const decodeMs = performance.now() - decodeStart;
        wasm.apply_tone(1, 0.22, 0.18, -0.08, 0.12, -0.2, 0.24, 0.96);
        wasm.apply_color(1, 0.1, 0.2, 0.06, -0.04);
        wasm.apply_hsl(1, 0.03, 0.08, 0.0, -0.02, 0.04, 0.0, 0.01, 0.03, 0.0);
        wasm.apply_sharpen(1, 0.28);
        wasm.apply_vignette(1, 0.12);
        const scale = Math.min(1, 1440 / Math.max(info.canvas_width, info.canvas_height));
        const targetWidth = Math.max(256, Math.round(info.canvas_width * scale));
        const targetHeight = Math.max(256, Math.round(info.canvas_height * scale));
        const renderSamples = [];
        let frame = null;
        for (let i = 0; i < 3; i += 1) {
          const renderStart = performance.now();
          frame = await wasm.render_preview_rgba({
            target_width: targetWidth,
            target_height: targetHeight,
            crop: null,
            ignore_crop_layers: false,
          });
          renderSamples.push(performance.now() - renderStart);
        }
        renderSamples.sort((a, b) => a - b);
        return {
          fixture: ${JSON.stringify(fixture.key)},
          wasm_init_ms: wasmInitMs,
          renderer_init_ms: rendererInitMs,
          decode_ms: decodeMs,
          render_ms: renderSamples[Math.floor(renderSamples.length / 2)],
          pixel_bytes: frame?.pixels?.length ?? 0,
        };
      })()
    `;
    const result = await rpc("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "benchmark evaluate failed");
    }
    return result.result.value;
  } finally {
    try {
      ws?.close();
    } catch {}
    chromeProcess.kill("SIGTERM");
    await new Promise((resolve) => chromeProcess.once("exit", resolve));
  }
}

const perFixture = [];
let runIndex = 0;
for (const fixture of fixtures) {
  const samples = [];
  for (let i = 0; i < repetitions; i += 1) {
    runIndex += 1;
    samples.push(await benchOnce(fixture, runIndex));
  }
  const summary = {
    key: fixture.key,
    decode_ms: median(samples.map((sample) => sample.decode_ms)),
    renderer_init_ms: median(samples.map((sample) => sample.renderer_init_ms)),
    render_ms: median(samples.map((sample) => sample.render_ms)),
    wasm_init_ms: median(samples.map((sample) => sample.wasm_init_ms)),
  };
  summary.open_preview_ms = summary.decode_ms + summary.renderer_init_ms + summary.render_ms;
  perFixture.push(summary);
}

const decodeMs = mean(perFixture.map((fixture) => fixture.decode_ms));
const rendererInitMs = mean(perFixture.map((fixture) => fixture.renderer_init_ms));
const renderMs = mean(perFixture.map((fixture) => fixture.render_ms));
const wasmInitMs = mean(perFixture.map((fixture) => fixture.wasm_init_ms));
const openPreviewMs = mean(perFixture.map((fixture) => fixture.open_preview_ms));

console.log(`METRIC open_preview_ms=${openPreviewMs.toFixed(3)}`);
console.log(`METRIC decode_ms=${decodeMs.toFixed(3)}`);
console.log(`METRIC renderer_init_ms=${rendererInitMs.toFixed(3)}`);
console.log(`METRIC render_ms=${renderMs.toFixed(3)}`);
console.log(`METRIC wasm_init_ms=${wasmInitMs.toFixed(3)}`);
for (const fixture of perFixture) {
  console.log(`METRIC ${fixture.key}_open_preview_ms=${fixture.open_preview_ms.toFixed(3)}`);
}
