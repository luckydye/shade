import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import http from "node:http";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? "4318");
const root = resolve(".");

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".cr3", "image/x-canon-cr3"],
]);

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith("/")) {
    path = join(path, "index.html");
  }
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root)) {
    send(res, 403, "forbidden");
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    send(res, 404, "not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime.get(extname(file).toLowerCase()) ?? "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`listening ${host}:${port}`);
});
