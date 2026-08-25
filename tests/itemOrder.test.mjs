import assert from "node:assert/strict";
import test from "node:test";

import {
  mergePersistedOrder,
  moveWithinSection,
  reconcileVisibleOrder,
} from "../src/dock/itemOrder.js";

test("reconcile preserves visible order and inserts persisted neighbors", () => {
  assert.deepEqual(
    reconcileVisibleOrder(
      ["app:b", "app:volatile"],
      new Set(["app:a", "app:b", "app:volatile"]),
      ["app:a", "app:b"],
    ),
    ["app:a", "app:b", "app:volatile"],
  );
});

test("reconcile removes stale ids and appends new volatile ids", () => {
  assert.deepEqual(
    reconcileVisibleOrder(
      ["app:gone", "app:a"],
      new Set(["app:a", "app:new"]),
      ["app:a"],
    ),
    ["app:a", "app:new"],
  );
});

test("move stays within the source section", () => {
  const sectionOf = (id) => id.split(":", 1)[0];
  assert.deepEqual(
    moveWithinSection(
      ["app:a", "folder:x", "app:b", "folder:y"],
      "app:a",
      1,
      sectionOf,
    ),
    ["folder:x", "app:b", "app:a", "folder:y"],
  );
});

test("merge keeps unknown persisted ids anchored", () => {
  assert.deepEqual(
    mergePersistedOrder(
      ["app:a", "group:future", "folder:x", "app:b"],
      ["app:b", "folder:x", "app:a"],
    ),
    ["app:b", "group:future", "folder:x", "app:a"],
  );
});
