import assert from "node:assert/strict";
import test from "node:test";
import { runTownSoak } from "./living-town-soak.mjs";
import { EconomyModel, economy } from "./living-town-economy.mjs";
test("twelve active hours plus one hundred missed days preserve budgets, stock, source/sink conservation and bounded customer opportunities", (t) => {
  const r = runTownSoak({
    epochs: 720,
    downtimeAt: 360,
    downtimeEpochs: 144000,
  });
  assert.equal(r.economicEpoch, "144720");
  assert.equal(r.providerCalls, 0);
  assert.equal(r.providerReservedMicro, 0);
  assert(r.metrics.sales > 200);
  assert.equal(r.metrics.eligibleUnfunded, 0);
  assert.equal(r.metrics.rawStockouts, 0);
  assert(r.metrics.maxActiveEpochsBetweenSales <= 4);
  assert(BigInt(r.metrics.maxEconomicEpochsBetweenSales) >= 144000n);
  assert.equal(
    r.metrics.sales +
      Object.values(r.metrics.noPurchase).reduce((a, b) => a + b, 0),
    720 * 4,
  );
  const gold =
    BigInt(r.gold.player) +
    BigInt(r.gold.customer) +
    Object.values(r.gold.merchants).reduce((a, b) => a + BigInt(b), 0n);
  assert.equal(gold, BigInt(r.gold.issued) - BigInt(r.gold.burned));
  assert(BigInt(r.gold.customer) <= 200n);
  assert(BigInt(r.gold.issued) <= 800n + 720n * 100n);
  for (const [item, v] of Object.entries(r.items)) {
    assert.equal(
      BigInt(v.held),
      BigInt(v.seed) +
        BigInt(v.supplied) +
        BigInt(v.produced) -
        BigInt(v.consumed),
    );
    if (economy.materials[item]) {
      assert(BigInt(v.consumed) > BigInt(v.seed));
      assert(
        BigInt(v.supplied) <= 720n * BigInt(economy.materials[item].supply),
      );
      assert(
        BigInt(r.metrics.stock[item].min) >=
          BigInt(economy.materials[item].floor),
      );
      const band = r.metrics.prices[item];
      assert(BigInt(band.min) >= BigInt(economy.materials[item].minPrice));
      assert(BigInt(band.max) <= BigInt(economy.materials[item].maxPrice));
    }
  }
  assert(r.commands < 10000);
  assert(Object.keys(r.modelAllocations).length <= 8);
  t.diagnostic("P49_LONG_RUN_REPORT=" + JSON.stringify(r));
});
test("the announced shortage changes only its bounded source interval and identical recorded inputs replay the same demand trace", () => {
  const event = runTownSoak({ epochs: 24 }),
    again = runTownSoak({ epochs: 24 }),
    baseline = runTownSoak({ epochs: 24, shortage: false });
  assert.deepEqual(event, again);
  assert.equal(
    event.metrics.supplyTrace.find((x) => x.item === "herb" && x.epoch === "1")
      .amount,
    "4",
  );
  assert.equal(
    baseline.metrics.supplyTrace.find(
      (x) => x.item === "herb" && x.epoch === "1",
    ).amount,
    "8",
  );
  assert(
    event.metrics.supplyTrace
      .filter((x) => x.item === "herb" && BigInt(x.epoch) < 6n)
      .every((x) => BigInt(x.amount) <= 4n),
  );
  assert.notEqual(
    event.traceDigest,
    runTownSoak({ epochs: 24, seed: "43" }).traceDigest,
  );
});
test("unfunded and overpriced stock expose starvation rather than inventing demand or rescue gold, and valid repricing recovers", () => {
  const unfunded = runTownSoak({ epochs: 120, funding: false }),
    recovery = runTownSoak({ epochs: 120, overpriceUntil: 24 });
  assert.equal(unfunded.gold.issued, "800");
  assert(unfunded.metrics.eligibleUnfunded > 0);
  assert(unfunded.metrics.maxActiveEpochsBetweenSales > 30);
  assert(recovery.metrics.overpriced > 0);
  assert(recovery.metrics.sales > 20);
  assert(BigInt(recovery.gold.player) > 0n);
  const model = new EconomyModel({ supplyCeiling: () => 9n });
  model.register("register");
  model.advance(60n);
  const before = structuredClone(model.state);
  assert.throws(
    () => model.allocate("hostile-modifier", "supply", "herb"),
    /exceeds baseline/,
  );
  assert.deepEqual(model.state, before);
});
