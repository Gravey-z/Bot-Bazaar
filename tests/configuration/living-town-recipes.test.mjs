import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { livingTownRecipeIds } from "../../packages/shared/dist/index.js";
import {
  LivingTownClient,
  livingTownRecipe,
  livingTownRecipeId,
  livingTownRecipeEntry,
  livingTownProductionTerms,
  planLivingTownProduction,
  decodeLivingTownSnapshot,
  parseLivingTownJson,
} from "../../packages/chain/dist/index.js";

const captured = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-recipes-sandbox.json", "utf8"),
);
const snapshot = JSON.parse(Buffer.from(captured.recipes.result).toString());
const foundation = JSON.parse(
  Buffer.from(captured.foundation.result).toString(),
);
const config = JSON.parse(readFileSync("config/living-town-v1.json", "utf8"));
const recipes = snapshot.data.items.map(
  (row) => livingTownRecipeEntry(row).recipe,
);
const clone = (v) => structuredClone(v);

test("actual WASM recipes match reviewed six-item inputs, outputs, versions and duration config", () => {
  assert.deepEqual(livingTownRecipeIds, ["health_potion", "iron_tool"]);
  assert.equal(recipes.length, 2);
  for (const r of recipes) {
    assert.equal(r.version, "1");
    assert.equal(r.output_item, r.recipe_id);
    assert.equal(r.output_per_unit, "1");
    assert.equal(
      r.duration_seconds,
      config.economy.recipes[r.recipe_id].seconds,
    );
    assert.equal(r.max_batch_quantity, config.limits.max_batch_quantity);
    for (const [key, n] of Object.entries(r.inputs))
      assert.equal(n, config.economy.recipes[r.recipe_id].inputs[key] ?? "0");
  }
  assert(foundation.data.supported_methods.includes("get_recipes"));
});

test("whole batches scale inputs, outputs and duration linearly and freeze copied job terms", () => {
  for (const r of recipes)
    for (const q of ["1", "3", "10"]) {
      const terms = planLivingTownProduction(r, "1", q, "42");
      assert.equal(
        terms.ready_at_ns,
        (
          42n +
          BigInt(q) * BigInt(r.duration_seconds) * 1_000_000_000n
        ).toString(),
      );
      assert.equal(terms.output_quantity, q);
      assert.equal(terms.recipe_version, "1");
      assert.equal(terms.config_version, "1");
      for (const [key, n] of Object.entries(r.inputs))
        assert.equal(
          terms.inputs_consumed[key],
          (BigInt(n) * BigInt(q)).toString(),
        );
      assert(Object.isFrozen(terms));
      assert(Object.isFrozen(terms.inputs_consumed));
      const changed = clone(r);
      changed.duration_seconds = "1";
      changed.version = "2";
      assert.throws(() => planLivingTownProduction(changed, "2", q, "42"));
      assert.deepEqual(
        livingTownProductionTerms(JSON.parse(JSON.stringify(terms))),
        terms,
      );
    }
});

test("unknown versions/recipes and zero, fractional, unsafe or oversized batches are rejected", () => {
  for (const id of ["unknown", "wood", "HEALTH_POTION", 1])
    assert.throws(() => livingTownRecipeId(id));
  for (const q of [
    "0",
    "11",
    "18446744073709551615",
    "18446744073709551616",
    "1.5",
    "01",
    "-1",
    "1e1",
    " 1",
    1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() => planLivingTownProduction(recipes[0], "1", q, "42"));
  for (const version of ["0", "2", 1])
    assert.throws(() =>
      planLivingTownProduction(recipes[0], version, "1", "42"),
    );
  assert.throws(() => livingTownRecipe({ ...recipes[0], version: "2" }));
  assert.throws(() => livingTownRecipe({ ...recipes[0], extra: true }));
  assert.throws(() =>
    parseLivingTownJson(
      '{"recipe_id":"health_potion","recipe_id":"iron_tool"}',
    ),
  );
});

test("nanosecond arithmetic accepts the exact u64 boundary and rejects overflow without changing input", () => {
  for (const r of recipes) {
    const before = clone(r),
      duration = BigInt(r.duration_seconds) * 10n * 1_000_000_000n,
      max = 18446744073709551615n;
    const start = max - duration;
    assert.equal(
      planLivingTownProduction(r, "1", "10", start.toString()).ready_at_ns,
      max.toString(),
    );
    assert.throws(() =>
      planLivingTownProduction(r, "1", "10", (start + 1n).toString()),
    );
    assert.throws(() =>
      planLivingTownProduction(r, "1", "1", "18446744073709551616"),
    );
    assert.deepEqual(r, before);
  }
});

test("recipe and stored-term decoders reject forged counts, outputs, timing and entry identity", () => {
  for (const mutate of [
    (r) => (r.inputs.herb = "3"),
    (r) => (r.duration_seconds = "1"),
    (r) => (r.output_item = "iron_tool"),
    (r) => (r.output_per_unit = "2"),
    (r) => (r.max_batch_quantity = "100"),
  ]) {
    const bad = clone(recipes[0]);
    mutate(bad);
    assert.throws(() => livingTownRecipe(bad));
  }
  assert.throws(() =>
    livingTownRecipeEntry({ recipe_entry_id: "2", recipe: recipes[0] }),
  );
  const terms = planLivingTownProduction(recipes[0], "1", "10", "42");
  for (const mutate of [
    (t) => (t.inputs_consumed.herb = "19"),
    (t) => (t.output_quantity = "9"),
    (t) => (t.ready_at_ns = (BigInt(t.ready_at_ns) - 1n).toString()),
    (t) => (t.output_item = "iron_tool"),
    (t) => (t.recipe_version = "2"),
    (t) => (t.config_version = "2"),
  ]) {
    const bad = clone(terms);
    mutate(bad);
    assert.throws(() => livingTownProductionTerms(bad));
  }
});

function readerFixture(change = () => {}) {
  const calls = [];
  const rpc = async (method, p) => {
    calls.push({ method, params: p });
    let result;
    if (method === "status")
      result = { chain_id: "testnet", sync_info: { syncing: false } };
    else if (method === "EXPERIMENTAL_genesis_config")
      result = { chain_id: "testnet", genesis_height: 7 };
    else if (method === "block")
      result =
        p.block_id === 7
          ? { header: { height: 7, hash: foundation.deployment.genesis_hash } }
          : clone(captured.block);
    else if (method === "query") {
      if (p.request_type === "view_account") result = clone(captured.account);
      else if (p.method_name === "get_foundation")
        result = clone(captured.foundation);
      else if (p.method_name === "get_recipes") {
        const args = JSON.parse(
          Buffer.from(p.args_base64, "base64").toString(),
        );
        const remaining = snapshot.data.items.filter(
          (row) =>
            args.after_id === null ||
            BigInt(row.recipe_entry_id) > BigInt(args.after_id),
        );
        const items = remaining.slice(0, Number(args.limit));
        const body = {
          ...clone(snapshot),
          data: {
            items,
            next_after_id: items.at(-1)?.recipe_entry_id ?? args.after_id,
            has_more: remaining.length > items.length,
            history_gap: false,
            pruned_through: "0",
          },
        };
        result = {
          ...captured.recipes,
          result: [...Buffer.from(JSON.stringify(body))],
        };
      } else throw Error("unexpected method " + p.method_name);
    } else throw Error("unexpected RPC " + method);
    change(method, p, result);
    return result;
  };
  const identity = {
    deployment: foundation.deployment,
    codeHash: captured.account.code_hash,
    ownerId: foundation.data.owner_account_id,
    operatorId: foundation.data.operator_account_id,
    controllers: foundation.data.merchant_controllers,
  };
  return { client: new LivingTownClient(identity, rpc), calls };
}

test("typed recipe reader admits the actual code/foundation and binds ordered pages to block and revision", async () => {
  const { client, calls } = readerFixture(),
    reader = await client.finalized();
  const first = await reader.getRecipes({
    after_id: null,
    limit: "1",
    expected_market_revision: snapshot.market_revision,
  });
  assert.equal(first.data.items[0].recipe.recipe_id, "health_potion");
  assert(first.data.has_more);
  const next = await reader.getRecipes({
    after_id: first.data.next_after_id,
    limit: "1",
    expected_market_revision: snapshot.market_revision,
  });
  assert.equal(next.data.items[0].recipe.recipe_id, "iron_tool");
  assert.equal(next.data.has_more, false);
  assert(
    calls
      .filter((c) => c.method === "query")
      .every((c) => c.params.block_id === reader.block.hash),
  );
  assert.deepEqual(
    decodeLivingTownSnapshot(
      snapshot,
      foundation.deployment,
      (v) => v,
    ).data.items.map(livingTownRecipeEntry),
    snapshot.data.items,
  );
  await assert.rejects(
    reader.getRecipes({
      after_id: null,
      limit: "51",
      expected_market_revision: snapshot.market_revision,
    }),
  );
  await assert.rejects(
    reader.getRecipes({
      after_id: null,
      limit: "1",
      expected_market_revision: "999",
    }),
  );
  for (const corrupt of [
    (b) => (b.data.next_after_id = "2"),
    (b) => (b.data.items[0].recipe.version = "2"),
    (b) => (b.deployment.config_version = "2"),
  ]) {
    const bad = readerFixture((m, p, r) => {
      if (m === "query" && p.method_name === "get_recipes") {
        const b = JSON.parse(Buffer.from(r.result).toString());
        corrupt(b);
        r.result = [...Buffer.from(JSON.stringify(b))];
      }
    });
    await assert.rejects(
      (await bad.client.finalized()).getRecipes({
        after_id: null,
        limit: "1",
        expected_market_revision: snapshot.market_revision,
      }),
    );
  }
});
