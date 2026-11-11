import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  demoLimits,
  transactionSummary,
  sendDemoTransaction,
  near,
  load,
} from "../../scripts/living-town-demo-deployment.mjs";
import {
  callReserveMicro,
  mayContinue,
  genuineSettlement,
  requiredPlayerSetup,
} from "../../scripts/living-town-demo-acceptance.mjs";
test("verified existing player setup is not granted or created again after a failed pre-inference attempt", () => {
  assert.deepEqual(requiredPlayerSetup(null), { register: true, shop: true });
  assert.deepEqual(requiredPlayerSetup({ shop_id: null }), {
    register: false,
    shop: true,
  });
  assert.deepEqual(requiredPlayerSetup({ shop_id: "4" }), {
    register: false,
    shop: false,
  });
});
test("acceptance limits deny unbounded opportunities, time and credits; reserve covers the largest reviewed call", () => {
  const limits = demoLimits();
  assert.equal(limits.max_inference_micro, 250000);
  assert(callReserveMicro < 21000);
  for (const bad of [
    { duration_ms: 900000 },
    { max_opportunities: 3 },
    { max_provider_calls: 13 },
    { max_inference_micro: 10000000 },
    { unlimited: true },
  ])
    assert.throws(() => demoLimits(bad));
  assert(mayContinue(limits, 0, 0, 0));
  assert(!mayContinue(limits, 600000, 0, 0));
  assert(!mayContinue(limits, 0, 12, 0));
  assert(!mayContinue(limits, 0, 0, 250000));
  assert(
    callReserveMicro * limits.max_provider_calls < limits.max_inference_micro,
  );
});
test("genuine settlement needs different validated buyer and seller model turns on the same root", () => {
  const audit = {
    roots: [
      { id: "root", close_reason: "accepted", offer_id: "1", trade_id: "2" },
    ],
    steps: [
      {
        root_id: "root",
        role: "buyer",
        merchant: "rex",
        decision: {
          origin: "model_proposal",
          inferenceRef: "buyer",
          proposal: { action: { type: "propose_trade" } },
        },
      },
      {
        root_id: "root",
        role: "seller",
        merchant: "luna",
        decision: {
          origin: "model_proposal",
          inferenceRef: "seller",
          proposal: { action: { type: "accept_trade" } },
        },
      },
    ],
    providers: [
      { id: "buyer", merchant: "rex", status: "accepted" },
      { id: "seller", merchant: "luna", status: "accepted" },
    ],
  };
  assert(genuineSettlement(audit));
  for (const mutate of [
    (a) => (a.steps[1].decision.origin = "rules"),
    (a) => (a.providers[1].status = "fallback"),
    (a) => (a.steps[1].merchant = "rex"),
    (a) => (a.steps[1].root_id = "other"),
    (a) => (a.steps[1].decision.proposal.action.type = "wait"),
    (a) => (a.roots[0].trade_id = null),
  ]) {
    const a = structuredClone(audit);
    mutate(a);
    assert.equal(genuineSettlement(a), undefined);
  }
});
const hash = "11111111111111111111111111111111";
const receipt = {
  transaction: {
    hash,
    signer_id: "owner.testnet",
    receiver_id: "contract.testnet",
  },
  status: { SuccessValue: "" },
  final_execution_status: "FINAL",
  transaction_outcome: {
    block_hash: hash,
    outcome: { gas_burnt: "10", tokens_burnt: "100" },
  },
  receipts_outcome: [
    {
      id: hash,
      block_hash: hash,
      outcome: { gas_burnt: "20", tokens_burnt: "200" },
    },
  ],
};
test("transaction evidence preserves all receipts and sums exact gas and burned tokens", () => {
  const summary = transactionSummary(receipt, "Controlled fixture");
  assert.equal(summary.gas_burnt, "30");
  assert.equal(summary.tokens_burnt_yocto, "300");
  assert.deepEqual(summary.receipt_ids, [hash]);
  assert.match(summary.url, /\/txns\//);
});
test("signed setup intent is never replaced on restart; public archives contain no credential or signed bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bazaar-demo-test-"));
  t.after(async () => {
    assert(
      resolve(directory).startsWith(resolve(tmpdir(), "bazaar-demo-test-")),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const plan = {
    directory,
    private_dir: join(directory, "private"),
    public_dir: join(directory, "public"),
    rpc_url: "https://rpc.example",
  };
  await mkdir(plan.private_dir);
  const key = near.KeyPairEd25519.fromRandom(),
    credential = {
      account_id: "owner.testnet",
      public_key: key.getPublicKey().toString(),
      private_key: key.toString(),
    };
  const originalFetch = globalThis.fetch;
  let sends = 0,
    lookups = 0;
  let actual;
  globalThis.fetch = async (_url, options) => {
    const { method } = JSON.parse(options.body);
    if (method === "query")
      return Response.json({
        result: { permission: "FullAccess", nonce: 1, block_hash: hash },
      });
    if (method === "send_tx") {
      sends++;
      const intent = await load(join(plan.private_dir, "example-intent.json"));
      actual = {
        ...receipt,
        transaction: { ...receipt.transaction, hash: intent.hash },
      };
      return Response.json({ result: actual });
    }
    assert.equal(method, "tx");
    lookups++;
    return Response.json({ result: actual });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await sendDemoTransaction(
    plan,
    "example",
    credential,
    "contract.testnet",
    [near.actions.transfer(1n)],
    "Controlled setup action",
  );
  const saved = await readFile(
    join(plan.private_dir, "example-intent.json"),
    "utf8",
  );
  await sendDemoTransaction(
    plan,
    "example",
    credential,
    "contract.testnet",
    [],
    "Controlled setup action",
  );
  assert.equal(
    await readFile(join(plan.private_dir, "example-intent.json"), "utf8"),
    saved,
  );
  assert.equal(sends, 1);
  assert.equal(lookups, 1);
  const records = await readFile(
    join(plan.public_dir, "transactions.json"),
    "utf8",
  );
  assert(!records.includes(credential.private_key));
  assert(!records.includes("signed_base64"));
  assert.equal(JSON.parse(records).length, 1);
});
