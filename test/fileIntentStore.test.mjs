import assert from "node:assert/strict";
import test from "node:test";

import { FileIntentStore } from "../dist/fileIntentStore.js";

const alice = { accountId: "a", sessionKey: "s", senderId: "alice" };

test("intent is isolated and consumed once", () => {
  const store = new FileIntentStore();
  store.arm(alice, 1000, 100);
  assert.equal(store.consume({ ...alice, senderId: "bob" }, 200), false);
  assert.equal(store.consume(alice, 200), true);
  assert.equal(store.consume(alice, 200), false);
});

test("intent expires and can be cancelled", () => {
  const store = new FileIntentStore();
  store.arm(alice, 100, 100);
  assert.equal(store.has(alice, 201), false);
  store.arm(alice, 100, 300);
  assert.equal(store.cancel(alice), true);
  assert.equal(store.has(alice, 301), false);
});
