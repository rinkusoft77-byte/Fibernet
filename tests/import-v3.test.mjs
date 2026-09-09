import test from "node:test";
import assert from "node:assert/strict";

test("v3 Worker module imports", async () => {
  const mod = await import("../src/index-v3.js");
  assert.equal(typeof mod.default?.fetch, "function");
  assert.equal(typeof mod.default?.scheduled, "function");
});
