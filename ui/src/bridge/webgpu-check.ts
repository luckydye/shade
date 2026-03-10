/**
 * Check if WebGPU is available in the current browser.
 */
export async function checkWebGPU(): Promise<{ available: boolean; reason?: string }> {
  if (typeof navigator === "undefined") {
    return { available: false, reason: "Not in a browser environment" };
  }
  if (!("gpu" in navigator)) {
    return { available: false, reason: "WebGPU API not present (try Chrome 113+ or Firefox Nightly)" };
  }
  try {
    const adapter = await (navigator as any).gpu.requestAdapter();
    if (!adapter) {
      return { available: false, reason: "No WebGPU adapter found" };
    }
    return { available: true };
  } catch (e) {
    return { available: false, reason: String(e) };
  }
}
