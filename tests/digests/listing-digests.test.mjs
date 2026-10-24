import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalListingAction,
  listingActionDigest,
} from "../../packages/chain/dist/index.js";

const vectors = JSON.parse(
  await readFile(
    new URL("../fixtures/listing-digests.json", import.meta.url),
    "utf8",
  ),
);

test("TypeScript listing digests match the shared Rust vectors", async () => {
  for (const vector of vectors) {
    assert.equal(canonicalListingAction(vector.args), vector.canonical);
    assert.equal(await listingActionDigest(vector.args), vector.sha256);
    const reordered = Object.fromEntries(Object.entries(vector.args).reverse());
    assert.equal(await listingActionDigest(reordered), vector.sha256);
  }
});

test("listing digest validation rejects ambiguous wire values and unknown keys", () => {
  for (const value of [
    1,
    "01",
    "-1",
    "+1",
    " 1",
    "1 ",
    "1.0",
    "",
    "18446744073709551616",
    null,
  ]) {
    assert.throws(() =>
      canonicalListingAction({ ...vectors[0].args, quantity: value }),
    );
  }
  for (const patch of [
    { extra: "x" },
    { merchant_id: "other" },
    { resource: "gold" },
    { active: "true" },
    { expected_version: undefined },
  ]) {
    assert.throws(() =>
      canonicalListingAction({ ...vectors[0].args, ...patch }),
    );
  }
  const missing = { ...vectors[0].args };
  delete missing.action_id;
  assert.throws(() => canonicalListingAction(missing));
});
