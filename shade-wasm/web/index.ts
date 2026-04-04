export function createShadeWorker() {
  return new Worker(new URL("./shade.worker.ts", import.meta.url), {
    type: "module",
  });
}
