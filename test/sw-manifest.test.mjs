// The service worker's precache list is load-bearing: a missing file breaks
// offline, a duplicate makes addAll throw and aborts every install, and a
// listed file that does not exist fails install the same way. None of that
// shows up in local e2e because the worker only registers on https.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(path.join(ROOT, "app", "sw.js"), "utf8");
const listSrc = sw.match(/const PRECACHE = \[([^\]]+)\]/)[1];
const precache = [...listSrc.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

test("no duplicates (addAll throws on them)", () => {
  assert.equal(new Set(precache).size, precache.length);
});

test("cache version tracks the app version, so releases bust the cache", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = sw.match(/const VERSION = "([^"]+)"/)[1];
  assert.equal(version, `magpie-v${pkg.version}`);
});

test("every listed file exists", () => {
  for (const entry of precache) {
    if (entry === "/") continue;
    assert.ok(existsSync(path.join(ROOT, "app", entry)), `${entry} listed but missing`);
  }
});

test("every shipped script and stylesheet is listed", () => {
  for (const file of readdirSync(path.join(ROOT, "app", "js"))) {
    assert.ok(precache.includes(`/js/${file}`), `/js/${file} not precached`);
  }
  for (const file of readdirSync(path.join(ROOT, "app", "css"))) {
    assert.ok(precache.includes(`/css/${file}`), `/css/${file} not precached`);
  }
});
