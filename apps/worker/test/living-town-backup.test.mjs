import assert from "node:assert/strict";
import test from "node:test";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  appendFileSync,
  unlinkSync,
  writeFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createLivingTownCall,
  createLivingTownCompletionCall,
  verifyLivingTownReceipt,
  verifyLivingTownCompletionReceipt,
  livingTownIndexedReceipt,
  livingTownIndexedCompletion,
} from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "../dist/private/living-town/store.js";
import {
  createTownBackup,
  verifyTownBackup,
  restoreTownBackup,
} from "../dist/private/living-town/backup.js";
import { replayLivingTownArchive } from "../dist/private/living-town/archive.js";

const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-upgrade-sandbox.json", "utf8"),
);
const economy = JSON.parse(readFileSync("config/living-town-v1.json", "utf8"));
const first = capture.steps[0];
const identity = {
  deployment: first.foundation.deployment,
  codeHash: first.account.code_hash,
  ownerId: first.foundation.data.owner_account_id,
  operatorId: first.foundation.data.operator_account_id,
  controllers: first.foundation.data.merchant_controllers,
};
const block = (b) => ({
  hash: b.header.hash,
  height: String(b.header.height),
  timestampNs: b.header.timestamp_nanosec,
});
const baseline = { ...capture.baseline, block: block(capture.baseline.block) };
const blocks = new Map(
  capture.steps.map((s) => [s.block.header.hash, block(s.block)]),
);
const records = await Promise.all(
  capture.steps.map(async (s) => {
    const complete = s.method === "complete_production",
      proof = {
        transactionHash: s.transaction_hash,
        signerId: s.signer_id,
        deployment: identity.deployment,
        call: complete
          ? createLivingTownCompletionCall(s.args)
          : createLivingTownCall(s.method, s.args),
        referenceBlockHeight: s.reference_block_height,
      };
    const status = await (
      complete ? verifyLivingTownCompletionReceipt : verifyLivingTownReceipt
    )(s.receipt, proof, async (hash) => {
      assert(blocks.has(hash));
      return blocks.get(hash);
    });
    return (complete ? livingTownIndexedCompletion : livingTownIndexedReceipt)(
      proof,
      { status, response: s.receipt },
    );
  }),
);
function fixture(t, entries = records) {
  const root = mkdtempSync(join(tmpdir(), "bazaar-p73-")),
    path = join(root, "source");
  mkdirSync(path);
  const stores = [],
    store = new LivingTownProjectionStore(path, identity, true);
  stores.push(store);
  store.baseline(baseline);
  for (const record of entries) store.commit(record);
  t.after(() => {
    for (const s of stores) s.close();
    assert(root.startsWith(join(tmpdir(), "bazaar-p73-")));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    open(path, create = false, selected = identity) {
      const s = new LivingTownProjectionStore(path, selected, create);
      stores.push(s);
      return s;
    },
  };
}
test("consistent V2 bundle restores jobs, reservations, policy revisions, FIFO costs and cursor against captured chain state", async (t) => {
  const f = fixture(t),
    bundle = join(f.root, "bundle"),
    destination = join(f.root, "restore");
  const manifest = await createTownBackup(f.store, bundle, economy);
  assert.equal(manifest.mode, "non_signing_projection_only");
  assert.equal(manifest.report.missingProofs, 0);
  assert.equal(manifest.report.historyComplete, true);
  await restoreTownBackup(bundle, destination, identity);
  assert.deepEqual(
    (await verifyTownBackup(destination, identity)).report,
    manifest.report,
  );
  const restored = f.open(destination),
    expected = f.store.history("4", null, 50).snapshot.data;
  assert.deepEqual(
    restored.inventory("4").snapshot.data,
    capture.baseline.shops[0].ledger.data,
  );
  assert.deepEqual(
    restored.shopView("4").snapshot.data,
    capture.baseline.shops[0].shop.data,
  );
  assert.equal(
    restored.shopView("4").snapshot.data.policy_revision,
    capture.baseline.shops[0].shop.data.policy_revision,
  );
  assert.deepEqual(
    restored.production("4").snapshot.data,
    f.store.production("4").snapshot.data,
  );
  assert.deepEqual(restored.history("4", null, 50).snapshot.data, expected);
  assert.equal(expected.costs.recorded_profit, "84");
  assert.equal(expected.costs.recorded_upgrade_spending, "150");
  assert.deepEqual(restored.cursor(), f.store.cursor());
  assert.deepEqual(restored.events(), f.store.events());
  assert.equal(existsSync(join(destination, "worker.sqlite")), false);
  assert.equal(
    restored.town().stale,
    true,
    "restore does not pretend to be freshly synchronized",
  );
  const readerPath = join(f.root, "identity.json");
  writeFileSync(readerPath, JSON.stringify(identity));
  const cli = spawnSync(
    process.execPath,
    ["scripts/living-town-backup.mjs", "verify", readerPath, bundle],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).mode, "non_signing_projection_only");
  // Explicit opt-in keeps ordinary test runs disposable and source fixtures intact.
  const evidence = process.env.BAZAAR_BACKUP_PROOF_DIR;
  if (evidence) {
    assert(isAbsolute(evidence));
    mkdirSync(evidence);
    cpSync(bundle, join(evidence, "bundle"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await restoreTownBackup(
      bundle,
      join(evidence, "isolated-restore"),
      identity,
    );
    writeFileSync(
      join(evidence, "identity.json"),
      JSON.stringify(identity, null, 2),
    );
    writeFileSync(
      join(evidence, "proof.json"),
      JSON.stringify(
        {
          mode: "verified_captured_disposable_WASM_receipts_not_live_Testnet",
          signing: false,
          receiptRecordsChecked: records.length,
          manifest,
          sourceShop: restored.shopView("4").snapshot.data,
          sourceLedger: restored.inventory("4").snapshot.data,
          costs: expected.costs,
        },
        null,
        2,
      ),
    );
  }
});
test("an interrupted snapshot leaves an unaccepted partial bundle without changing the source", async (t) => {
  const f = fixture(t),
    before = f.store.counts(),
    output = join(f.root, "partial");
  f.store.snapshotTo = async () => {
    throw Error("controlled snapshot write failure");
  };
  await assert.rejects(
    createTownBackup(f.store, output, economy),
    /snapshot write failure/,
  );
  assert.equal(existsSync(join(output, "INCOMPLETE")), true);
  await assert.rejects(verifyTownBackup(output, identity));
  assert.deepEqual(f.store.counts(), before);
});
test("missing stored receipt proof remains explicit even when cached balances and profit are readable", async (t) => {
  const f = fixture(t);
  f.store.db.exec(
    "DELETE FROM projection_proofs WHERE tx_hash=(SELECT tx_hash FROM projection_proofs ORDER BY tx_hash LIMIT 1)",
  );
  const manifest = await createTownBackup(
    f.store,
    join(f.root, "bundle"),
    economy,
  );
  assert.equal(manifest.report.missingProofs, 1);
  assert.equal(manifest.report.historyComplete, false);
  assert.equal(f.store.history("4").snapshot.data.costs.recorded_profit, "84");
});
test("online snapshot retains actual running batches and their reserved output promises", async (t) => {
  const f = fixture(t, []),
    p = JSON.parse(
      readFileSync(
        "tests/fixtures/chain/living-town-production-sandbox.json",
        "utf8",
      ),
    ),
    step = p.steps[0];
  const selected = {
    deployment: step.foundation.deployment,
    codeHash: step.account.code_hash,
    ownerId: step.foundation.data.owner_account_id,
    operatorId: step.foundation.data.operator_account_id,
    controllers: step.foundation.data.merchant_controllers,
  };
  const s = p.after,
    cut = {
      block: block(s.block),
      town: s.town,
      shops: s.shops.map((row) => ({ shop: row.shop, ledger: row.ledger })),
      production: [
        ...["1", "2", "3"].map((shopId) => ({
          shopId,
          pages: [
            {
              ...s.town,
              data: {
                items: [],
                next_after_id: null,
                has_more: false,
                history_gap: false,
                pruned_through: "0",
              },
            },
          ],
        })),
        ...s.shops.map((row) => ({
          shopId: row.shop.data.shop_id,
          pages: [row.jobs],
        })),
      ],
    };
  const path = join(f.root, "running");
  mkdirSync(path);
  const source = f.open(path, true, selected);
  source.baseline(cut);
  const bundle = join(f.root, "running-bundle"),
    destination = join(f.root, "running-restore");
  await createTownBackup(source, bundle, economy);
  await restoreTownBackup(bundle, destination, selected);
  const restored = f.open(destination, false, selected);
  let running = 0;
  for (const row of s.shops) {
    assert.deepEqual(
      restored.inventory(row.shop.data.shop_id).snapshot.data,
      row.ledger.data,
    );
    assert.deepEqual(
      restored.production(row.shop.data.shop_id).snapshot.data,
      source.production(row.shop.data.shop_id).snapshot.data,
    );
    running += row.jobs.data.items.filter(
      (job) => job.status === "running",
    ).length;
  }
  assert(running > 0);
  assert(
    s.shops.some((row) =>
      Object.values(row.ledger.data.inventory.production_output_reserved).some(
        (count) => BigInt(count) > 0n,
      ),
    ),
  );
});
test("archive export and manifest come from the SQLite cut even if the live source advances", async (t) => {
  const withheld = records.find(
    (r) => r.proof.call.method === "purchase_upgrade",
  );
  const f = fixture(
      t,
      records.filter((r) => r !== withheld),
    ),
    before = f.store.counts().receipts;
  const original = f.store.snapshotTo.bind(f.store);
  f.store.snapshotTo = async (path) => {
    await original(path);
    f.store.commit(withheld);
  };
  const manifest = await createTownBackup(
    f.store,
    join(f.root, "bundle"),
    economy,
  );
  assert.equal(manifest.report.receipts, before);
  assert.equal(f.store.counts().receipts, before + 1);
  assert.deepEqual(
    (await verifyTownBackup(join(f.root, "bundle"), identity)).report,
    manifest.report,
  );
});
test("checksum corruption and missing referenced receipts reject restore before creating a destination", async (t) => {
  const f = fixture(t),
    bundle = join(f.root, "bundle");
  const m = await createTownBackup(f.store, bundle, economy);
  const artifact = join(bundle, m.archives[0].file),
    body = readFileSync(artifact);
  appendFileSync(artifact, " ");
  await assert.rejects(
    restoreTownBackup(bundle, join(f.root, "bad"), identity),
    /checksum/,
  );
  assert.equal(existsSync(join(f.root, "bad")), false);
  writeFileSync(artifact, body);
  unlinkSync(artifact);
  await assert.rejects(verifyTownBackup(bundle, identity), /artifacts/);
});
test("wrong deployment/config and unsafe manifest filenames are rejected without overwriting existing paths", async (t) => {
  const f = fixture(t),
    bundle = join(f.root, "bundle");
  await createTownBackup(f.store, bundle, economy);
  await assert.rejects(
    verifyTownBackup(bundle, {
      ...identity,
      codeHash: "11111111111111111111111111111111",
    }),
    /identity/,
  );
  await assert.rejects(
    createTownBackup(f.store, join(f.root, "bad-config"), {
      ...economy,
      unexpected: "secret",
    }),
    /config/,
  );
  await assert.rejects(
    restoreTownBackup(bundle, join(f.root, "source"), identity),
    /exist/i,
  );
  const path = join(bundle, "manifest.json"),
    manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.archives[0].file = "../worker.sqlite";
  writeFileSync(path, JSON.stringify(manifest));
  await assert.rejects(
    verifyTownBackup(bundle, identity),
    /artifacts|filename/,
  );
});
test("complete archived receipts rebuild costs through a controlled contract history-retention gap", async (t) => {
  const f = fixture(t),
    bundle = join(f.root, "bundle"),
    manifest = await createTownBackup(f.store, bundle, economy);
  const gap = structuredClone(baseline);
  for (const group of gap.production)
    for (const page of group.pages) {
      page.data.items = page.data.items.filter((j) => j.job_id !== "1");
      page.data.history_gap = true;
      page.data.pruned_through = "1";
    }
  const dir = join(f.root, "rebuilt");
  mkdirSync(dir);
  const rebuilt = f.open(dir, true);
  rebuilt.baseline(gap);
  assert.equal(rebuilt.history("4").snapshot.data.costs.recorded_profit, null);
  const balance = rebuilt.inventory("4").snapshot.data;
  for (const file of manifest.archives) {
    await replayLivingTownArchive(
      {
        body: readFileSync(join(bundle, file.file), "utf8"),
        sha256: file.sha256,
      },
      rebuilt,
      async (hash) => {
        assert(blocks.has(hash));
        return blocks.get(hash);
      },
    );
  }
  assert.deepEqual(
    rebuilt.history("4", null, 50).snapshot.data.costs,
    f.store.history("4", null, 50).snapshot.data.costs,
  );
  assert.deepEqual(
    rebuilt.inventory("4").snapshot.data,
    balance,
    "historical costs cannot rewind chain balances",
  );
  const partial = fixture(t, records.slice(15));
  const incomplete = await createTownBackup(
    partial.store,
    join(partial.root, "partial-bundle"),
    economy,
  );
  assert.equal(incomplete.report.historyComplete, false);
  assert.equal(
    partial.store.history("4").snapshot.data.costs.recorded_profit,
    null,
  );
});
