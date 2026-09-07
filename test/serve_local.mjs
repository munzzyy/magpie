// Tiny static server for tests and local dev. Serves app/ with the right
// content types. No caching, no directory listing.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const PORT = Number(process.argv[2] || 8940);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let file = decodeURIComponent(url.pathname);
    if (file === "/") file = "/index.html";
    // Test stand-in for the wrapper's share hand-off origin path.
    if (file.startsWith("/shared/")) {
      const body = await readFile(path.join(ROOT, "..", "test", "fixtures", "real-gps.jpg"));
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT)) throw new Error("traversal");
    const body = await readFile(full);
    res.writeHead(200, {
      "content-type": MIME[path.extname(full)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`sepia dev server on http://127.0.0.1:${PORT}`);
});
