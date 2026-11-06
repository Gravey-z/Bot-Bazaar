import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  livingTownIndexedReceipt,
} from "@bot-bazaar/chain";
import { LivingTownProjectionStore } from "../../dist/private/living-town/store.js";
export const block = (v) => ({
  hash: v.header.hash,
  height: String(v.header.height),
  timestampNs: v.header.timestamp_nanosec,
});
export const basic = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
export const eventCapture = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-market-event-sandbox.json",
    "utf8",
  ),
);
const foundation = JSON.parse(
  Buffer.from(basic.steps[0].foundation.result).toString(),
);
export const basicIdentity = {
  deployment: foundation.deployment,
  codeHash: basic.steps[0].account.code_hash,
  ownerId: foundation.data.owner_account_id,
  operatorId: foundation.data.operator_account_id,
  controllers: foundation.data.merchant_controllers,
};
const ef = eventCapture.steps[0];
export const eventIdentity = {
  deployment: ef.foundation.deployment,
  codeHash: ef.account.code_hash,
  ownerId: ef.foundation.data.owner_account_id,
  operatorId: ef.foundation.data.operator_account_id,
  controllers: ef.foundation.data.merchant_controllers,
};
const emptyJobs = (town) =>
  Array.from({ length: Number(town.data.next_shop_id) - 1 }, (_, i) => ({
    shopId: String(i + 1),
    pages: [
      {
        ...town,
        data: {
          items: [],
          next_after_id: null,
          has_more: false,
          history_gap: false,
          pruned_through: "0",
        },
      },
    ],
  }));
export const initial = {
  town: basic.initial_town,
  block: block(basic.initial_block),
  shops: [],
  production: emptyJobs(basic.initial_town),
};
export const final = {
  town: basic.final_views.get_town,
  block: block(basic.final_block),
  shops: [
    {
      shop: basic.final_views.get_shop,
      ledger: basic.final_views.get_shop_inventory,
    },
  ],
  production: emptyJobs(basic.final_views.get_town),
};
export const eventBaseline = (c = eventCapture.checkpoints.at(-1)) => ({
  town: c.town,
  block: block(c.block),
  shops: [],
  production: emptyJobs(c.town),
  marketEvents: c.events,
});
async function index(s, identity) {
  const proof = {
    transactionHash: s.transaction_hash,
    signerId: s.signer_id ?? basic.player_id,
    deployment: identity.deployment,
    call: createLivingTownCall(s.method, s.args),
    referenceBlockHeight: String(s.reference_block_height),
  };
  const status = await verifyLivingTownReceipt(
    s.receipt,
    proof,
    async (hash) => {
      assert.equal(hash, s.block.header.hash);
      return block(s.block);
    },
  );
  assert(["succeeded", "failed"].includes(status.kind));
  return livingTownIndexedReceipt(proof, { status, response: s.receipt });
}
export const basicRecords = await Promise.all(
  basic.steps.map((s) => index(s, basicIdentity)),
);
export const eventRecords = await Promise.all(
  eventCapture.steps.map((s) => index(s, eventIdentity)),
);
export function projectionFixture(
  t,
  identity = basicIdentity,
  baseline = initial,
) {
  const closers = [];
  const dir = mkdtempSync(join(tmpdir(), "bazaar-feed-"));
  let store = new LivingTownProjectionStore(dir, identity, true);
  store.baseline(baseline);
  t.after(() => {
    for (const close of closers) close();
    store.close();
    assert(dir.startsWith(join(tmpdir(), "bazaar-feed-")));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    onClose: (close) => closers.push(close),
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new LivingTownProjectionStore(dir, identity);
      return store;
    },
    sql(sql) {
      store.close();
      const db = new DatabaseSync(store.path);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
      store = new LivingTownProjectionStore(dir, identity);
    },
  };
}
export const agent = (cp = initial.town, id = "a") => ({
  source: "deterministic_rule",
  transaction_hint: null,
  checkpoint: {
    block_hash: initial.block.hash,
    block_height: cp.block_height,
    block_timestamp_ns: cp.block_timestamp_ns,
    market_revision: cp.market_revision,
    event_sequence: cp.event_sequence,
  },
  data: {
    action_id: id.repeat(64),
    tick_id: "b".repeat(64),
    merchant: "luna",
    proposal_type: "adjust_price",
    reason: "Maintain protected reserves.",
    validation: "price_in_policy",
    outcome: "awaiting_confirmation",
    command_digest: null,
    inference_ref: null,
    signals: [
      {
        item_id: "herb",
        held: "20",
        reserved: "12",
        scarcity_bps: "0",
        confirmed_demand: "0",
        suggested_price: "3",
      },
    ],
    transaction_hash: null,
    receipt_id: null,
  },
});
