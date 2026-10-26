import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalMerchantAction,
  merchantActionDigest,
} from "../../packages/chain/dist/index.js";

const vectors = JSON.parse(
  await readFile(
    new URL("../fixtures/merchant-action-digests.json", import.meta.url),
    "utf8",
  ),
);

test("every merchant method matches shared Rust digest vectors without numeric rounding", async () => {
  for (const vector of vectors) {
    const action = { method: vector.method, args: vector.args };
    assert.equal(canonicalMerchantAction(action), vector.canonical);
    assert.equal(await merchantActionDigest(action), vector.sha256);
    assert.equal(
      await merchantActionDigest({
        ...action,
        args: Object.fromEntries(Object.entries(action.args).reverse()),
      }),
      vector.sha256,
    );
  }
});

test("merchant digests distinguish methods, changed arguments and action IDs", async () => {
  const action = {
    method: "accept_trade",
    args: { offer_id: "1", action_id: "1" },
  };
  const digest = await merchantActionDigest(action);
  for (const changed of [
    { ...action, method: "cancel_trade" },
    { ...action, args: { offer_id: "2", action_id: "1" } },
    { ...action, args: { offer_id: "1", action_id: "2" } },
  ]) {
    assert.notEqual(await merchantActionDigest(changed), digest);
  }
});

test("merchant digests reject unknown or missing fields and ambiguous wire values", () => {
  for (const vector of vectors) {
    const { method, args } = vector;
    assert.throws(() =>
      canonicalMerchantAction({ method, args: { ...args, extra: "x" } }),
    );
    for (const key of Object.keys(args)) {
      const missing = { ...args };
      delete missing[key];
      assert.throws(() => canonicalMerchantAction({ method, args: missing }));
    }
    for (const value of [
      1,
      "01",
      "-1",
      "+1",
      " 1",
      "1.0",
      "",
      "18446744073709551616",
      null,
    ]) {
      assert.throws(() =>
        canonicalMerchantAction({
          method,
          args: { ...args, action_id: value },
        }),
      );
    }
  }
  for (const patch of [
    { buyer: "other" },
    { seller: { rex: null } },
    { proposer: null },
    { resource: "gold" },
  ]) {
    assert.throws(() =>
      canonicalMerchantAction({
        method: "propose_trade",
        args: { ...vectors[1].args, ...patch },
      }),
    );
  }
  for (const args of [null, [], "x"]) {
    assert.throws(() =>
      canonicalMerchantAction({ method: "accept_trade", args }),
    );
  }
  assert.throws(() =>
    canonicalMerchantAction({ method: "register_player", args: {} }),
  );
});
