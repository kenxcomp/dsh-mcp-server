import assert from "node:assert/strict";
import test from "node:test";

import { add } from "./add.mjs";

test("add(2, 3) returns 5", () => {
  assert.equal(add(2, 3), 5);
});

test("add(-2, 2) returns 0", () => {
  assert.equal(add(-2, 2), 0);
});

test("add(0, 0) returns 0", () => {
  assert.equal(add(0, 0), 0);
});
