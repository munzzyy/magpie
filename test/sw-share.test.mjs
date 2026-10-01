// Runs the worker's share-target handler with a fake cache: what it parks is
// what the page reads back at pickup.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;

function loadWorker() {
  const handlers = {};
  const parked = new Map();
  const cache = {
    keys: async () => [...parked.keys()],
    delete: async (k) => parked.delete(k),
    put: async (k, res) => void parked.set(k, res),
  };
  class SwResponse extends Response {
    static redirect(url, status) {
      return { redirect: url, status };
    }
  }
  const self = { addEventListener: (type, fn) => (handlers[type] = fn), location: { origin: "https://magpie.test" } };
  vm.runInNewContext(readFileSync(path.join(ROOT, "app", "sw.js"), "utf8"), {
    self,
    caches: { open: async () => cache },
    Response: SwResponse,
    URL,
    encodeURIComponent,
  });
  const share = async (files) => {
    const form = new FormData();
    for (const f of files) form.append("evidence", f);
    let answer;
    handlers.fetch({
      request: new Request("https://magpie.test/share", { method: "POST", body: form, headers: { "Sec-Fetch-Site": "same-origin" } }),
      respondWith: (p) => (answer = p),
    });
    return answer;
  };
  return { share, parked };
}

test("the share target parks each file with its name, and one over the cap without its body", async () => {
  const { share, parked } = loadWorker();
  const answer = await share([
    new File(["the lease"], "lease (signed) día 1.pdf", { type: "application/pdf" }),
    new File([new Uint8Array(51 * MB)], "kitchen leak.mp4", { type: "video/mp4" }),
  ]);
  assert.deepEqual(answer, { redirect: "/?share-target=1", status: 303 });
  assert.deepEqual([...parked.keys()], ["/share-incoming-0", "/share-incoming-1"]);

  const small = parked.get("/share-incoming-0");
  assert.equal(small.status, 200);
  assert.equal(small.headers.get("content-type"), "application/pdf");
  assert.equal(decodeURIComponent(small.headers.get("x-magpie-name")), "lease (signed) día 1.pdf");
  assert.equal(await small.text(), "the lease");

  const big = parked.get("/share-incoming-1");
  assert.equal(big.status, 413);
  assert.equal(decodeURIComponent(big.headers.get("x-magpie-name")), "kitchen leak.mp4");
  assert.equal((await big.arrayBuffer()).byteLength, 0);
});
