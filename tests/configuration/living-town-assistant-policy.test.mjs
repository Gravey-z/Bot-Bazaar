import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import {
  createLivingTownCall,
  verifyLivingTownReceipt,
  verifyLivingTownEffect,
  livingTownIndexedReceipt,
  livingTownAssistantPolicy,
  livingTownAssistantPolicyInput,
  livingTownFoundation,
  FinalizedLivingTownReader,
} from "../../packages/chain/dist/index.js";
import { townCall } from "../../apps/worker/dist/private/living-town/town-chain.js";
import {
  runtimeMethods,
  townMerchantMethods,
  townSourceMethods,
  customerRuntimeMethods,
} from "../../apps/worker/dist/private/near-signer.js";
const fixture = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-assistant-sandbox.json",
    "utf8",
  ),
);
const active = fixture.steps.find(
  (s) => s.method === "set_assistant_permissions",
);
const identity = {
  deployment: active.foundation.deployment,
  codeHash: active.account.code_hash,
  ownerId: active.foundation.data.owner_account_id,
  operatorId: active.foundation.data.operator_account_id,
  controllers: active.foundation.data.merchant_controllers,
};
const block = (s) => ({
  hash: s.block.header.hash,
  height: String(s.block.header.height),
  timestampNs: s.block.header.timestamp_nanosec,
});
const proof = (s) => ({
  transactionHash: s.transaction_hash,
  signerId: s.signer_id,
  deployment: s.foundation.deployment,
  call: createLivingTownCall(s.method, s.args),
  referenceBlockHeight: s.reference_block_height,
});
test("actual permission receipts verify exact SDK terms, original replays and indexed event bindings", async () => {
  // This is preserved P5.5 evidence; current artifact pins are checked by P5.6.
  for (const s of fixture.steps) {
    const p = proof(s),
      status = await verifyLivingTownReceipt(s.receipt, p, async () =>
        block(s),
      );
    assert.equal(status.kind, "succeeded");
    livingTownIndexedReceipt(p, { status, response: s.receipt });
  }
  assert.equal(fixture.active.data.revision, "2");
  assert.equal(fixture.after.data.mode, "off");
  assert.equal(fixture.after.data.revision, "5");
  assert.equal(fixture.steps.filter((s) => s.effect?.data?.replayed).length, 2);
});
test("actual rejected policy receipts prove failures without accepting synthetic effects", async () => {
  assert.equal(fixture.failures.length, 21);
  for (const s of fixture.failures) {
    // Malformed wire requests are refused before proof construction; valid hostile
    // requests have genuine failure receipts and no successful effect.
    let p;
    try {
      p = proof(s);
    } catch {
      assert.equal(s.succeeded, false);
      continue;
    }
    assert.equal(
      (await verifyLivingTownReceipt(s.receipt, p, async () => block(s))).kind,
      "failed",
    );
  }
});
for (const patch of [
  { mode: "buy" },
  { operator_account_id: null },
  { expires_at_ns: null },
  { allowed_items: [] },
  { allowed_items: ["herb"] },
  { allowed_items: ["iron_tool", "iron_tool"] },
  { min_price: "0" },
  { max_price: "101" },
  { min_price: "26" },
  { min_price: 5 },
  { min_price: "05" },
  { quantity: "1" },
  { recipient: "attacker.testnet" },
  { allowed_actions: ["buy_from_merchant"] },
])
  test(`policy decoder rejects unsupported scope ${JSON.stringify(patch)}`, () => {
    assert.throws(() =>
      createLivingTownCall("set_assistant_permissions", {
        ...active.args,
        policy: { ...active.args.policy, ...patch },
      }),
    );
  });
test("policy DTOs require explicit nullable keys, canonical off and sorted finalized products", () => {
  const p = structuredClone(active.args.policy);
  delete p.operator_account_id;
  assert.throws(() =>
    livingTownAssistantPolicyInput({ ...p, mode: "recommendations" }),
  );
  assert.throws(() =>
    livingTownAssistantPolicyInput({ ...active.args.policy, mode: "off" }),
  );
  assert.throws(() =>
    livingTownAssistantPolicy({
      ...fixture.active.data,
      allowed_items: ["iron_tool", "health_potion"],
    }),
  );
  assert.throws(() =>
    livingTownAssistantPolicy({ ...fixture.active.data, shop_id: "1" }),
  );
});
test("receipt effect rejects altered operator, band, scope, owner or policy revision", async () => {
  for (const mutate of [
    (r) => {
      r.data.outcome.policy.max_price = "26";
    },
    (r) => {
      r.data.outcome.policy.operator_account_id = "attacker.testnet";
    },
    (r) => {
      r.data.outcome.shop.owner.account_id = "attacker.testnet";
    },
    (r) => {
      r.data.outcome.policy.revision = "3";
    },
    (r) => {
      r.data.outcome.policy.allowed_items = ["iron_tool"];
    },
  ]) {
    const r = structuredClone(active.effect);
    mutate(r);
    await assert.rejects(
      verifyLivingTownEffect(
        r,
        identity.deployment,
        active.signer_id,
        createLivingTownCall(active.method, active.args),
      ),
    );
  }
});
test("finalized policy reader binds capability, shop revision and reviewed operator", async () => {
  const r = Object.create(FinalizedLivingTownReader.prototype);
  let policy = structuredClone(fixture.active),
    shop = structuredClone(active.effect.data.outcome.shop),
    f = structuredClone(active.foundation);
  r.getFoundation = async () => f;
  r.getShop = async () => ({ data: shop });
  r.view = async (method, args, decode) => {
    assert.equal(method, "get_assistant_policy");
    assert.equal(args.shop_id, "4");
    return { ...policy, data: decode(policy.data) };
  };
  assert.deepEqual((await r.getAssistantPolicy("4")).data, fixture.active.data);
  shop.policy_revision = "3";
  await assert.rejects(r.getAssistantPolicy("4"));
  shop.policy_revision = "2";
  policy.data.operator_account_id = "attacker.testnet";
  await assert.rejects(r.getAssistantPolicy("4"));
  policy = structuredClone(fixture.active);
  f.data.supported_methods = f.data.supported_methods.slice(0, -2);
  await assert.rejects(r.getAssistantPolicy("4"));
  livingTownFoundation(f.data);
  f.data.supported_methods.push("get_assistant_policy");
  assert.throws(() => livingTownFoundation(f.data));
});
test("player policy changes never enter any worker signer lane or authorize automatic actions", () => {
  for (const lane of ["operator", "rex", "luna", "bolt"])
    assert.throws(() => townCall(active.method, active.args, lane));
  for (const methods of [
    runtimeMethods,
    townMerchantMethods,
    townSourceMethods,
    customerRuntimeMethods,
  ])
    assert.equal(methods.includes(active.method), false);
  assert.throws(() => createLivingTownCall("assistant_reprice", {}));
});

const built = await build({
  stdin: {
    contents:
      "export {LivingTownTransactions} from './apps/web/src/app/living-town-transactions.ts'; export {LivingTownController} from './apps/web/src/app/living-town-controller.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { LivingTownTransactions, LivingTownController } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
);
function journalFixture() {
  const memory = new Map();
  let sends = 0,
    policy = structuredClone(fixture.initial.data),
    nextSequence = "3",
    paused = false,
    time = BigInt(fixture.initial.block_timestamp_ns);
  const shop = structuredClone(active.effect.data.outcome.shop);
  shop.policy_revision = "1";
  const reader = {
    block: {
      height: active.reference_block_height,
      get timestampNs() {
        return String(time);
      },
    },
    getCommand: async () => ({
      data: { kind: "not_applied", next_sequence: nextSequence },
    }),
    getTown: async () => ({ data: { paused } }),
    getShop: async () => ({ data: shop }),
    getAssistantPolicy: async () => ({ data: policy }),
  };
  const client = { identity, finalized: async () => reader };
  const make = () =>
    new LivingTownTransactions(
      client,
      {
        getItem: (k) => memory.get(k) ?? null,
        setItem: (k, v) => memory.set(k, v),
      },
      async () => {
        sends++;
        throw Error("unknown wallet handoff");
      },
      async (_k, work) => work(),
      () => "11111111-1111-4111-8111-111111111111",
    );
  return {
    make,
    shop,
    get sends() {
      return sends;
    },
    changePolicy() {
      policy.revision = "2";
    },
    activateForRevocation() {
      policy = structuredClone(fixture.active.data);
      shop.policy_revision = policy.revision;
      nextSequence = "4";
      time = BigInt(fixture.after.block_timestamp_ns);
    },
    pause() {
      paused = true;
    },
    expire() {
      time = BigInt(active.args.policy.expires_at_ns);
    },
  };
}
test("owner wallet policy review is durable and revalidates revision before handoff", async () => {
  const f = journalFixture(),
    j = f.make();
  const a = await j.prepare(active.signer_id, active.method, active.args);
  assert.equal(f.sends, 0);
  f.changePolicy();
  await assert.rejects(f.make().submit(a.id));
  assert.equal(f.sends, 0);
});
test("unknown policy wallet handoff cannot be resent on restore or double click", async () => {
  const f = journalFixture(),
    j = f.make(),
    a = await j.prepare(active.signer_id, active.method, active.args);
  await j.submit(a.id);
  assert.equal(f.sends, 1);
  const restored = f.make();
  await restored.restore();
  assert.equal((await restored.read()).phase, "unknown");
  await assert.rejects(restored.submit(a.id));
  assert.equal(f.sends, 1);
});
for (const failure of ["owner", "operator", "pause", "expiry"])
  test(`wallet admission refuses ${failure} before signing`, async () => {
    const f = journalFixture(),
      args = structuredClone(active.args);
    if (failure === "owner") f.shop.owner.account_id = "attacker.testnet";
    if (failure === "operator")
      args.policy.operator_account_id = "attacker.testnet";
    if (failure === "pause") f.pause();
    if (failure === "expiry") f.expire();
    await assert.rejects(
      f.make().prepare(active.signer_id, active.method, args),
    );
    assert.equal(f.sends, 0);
  });
test("owner controls request canonical disable and block a different account", async () => {
  const c = new LivingTownController(null, () => {});
  c.value = {
    ...c.value,
    accountId: active.signer_id,
    observation: {
      shop: active.effect.data.outcome.shop,
      assistantPolicy: fixture.active.data,
    },
  };
  let request;
  c.act = async (method, args) => {
    request = { method, args };
  };
  await c.setAssistantPermissionMode("off");
  assert.equal(request.method, "set_assistant_permissions");
  assert.equal(request.args.expected_policy_revision, "2");
  assert.deepEqual(request.args.policy, {
    mode: "off",
    operator_account_id: null,
    allowed_items: [],
    min_price: "1",
    max_price: "1",
    expires_at_ns: null,
  });
  c.value.accountId = "attacker.testnet";
  request = null;
  await c.setAssistantPermissionMode("recommendations");
  assert.equal(request, null);
});
test("canonical disable remains signable while the town is paused and the old policy has expired", async () => {
  const f = journalFixture();
  f.activateForRevocation();
  f.pause();
  const args = structuredClone(fixture.steps[4].args);
  args.command.valid_until_ns = (
    BigInt(fixture.after.block_timestamp_ns) + 300_000_000_000n
  ).toString();
  const j = f.make(),
    a = await j.prepare(active.signer_id, active.method, args);
  assert.equal(f.sends, 0);
  await j.submit(a.id);
  assert.equal(f.sends, 1);
});

test("owner automatic controls bind the reviewed operator, price band and explicit future expiry", async () => {
  const c = new LivingTownController({}, () => {}),
    now = Date.now();
  c.value = {
    ...c.value,
    phase: "ready",
    accountId: active.signer_id,
    transactionAvailable: true,
    observation: {
      ownershipKnown: true,
      stale: false,
      receivedAt: now,
      town: { paused: false },
      shop: active.effect.data.outcome.shop,
      assistantPolicy: fixture.active.data,
      assistantOperatorId: identity.operatorId,
      assistantRepriceAvailable: true,
      chainTimestampNs: fixture.active.block_timestamp_ns,
    },
  };
  let call;
  c.act = async (method, args) => {
    call = { method, args };
  };
  await c.enableAssistantRepricing("8", "15", "10");
  assert.equal(call.method, "set_assistant_permissions");
  assert.equal(call.args.policy.operator_account_id, identity.operatorId);
  assert.equal(
    call.args.policy.expires_at_ns,
    (BigInt(fixture.active.block_timestamp_ns) + 600_000_000_000n).toString(),
  );
  assert.equal(call.args.policy.mode, "auto_reprice");
  call = null;
  await c.enableAssistantRepricing("0", "15", "10");
  assert.equal(call, null);
  c.value.observation.assistantRepriceAvailable = false;
  await c.enableAssistantRepricing("8", "15", "10");
  assert.equal(call, null);
});
test("the owner wallet flow cannot submit an operator automatic action", async () => {
  const f = journalFixture();
  await assert.rejects(
    f.make().prepare(active.signer_id, "assistant_reprice", {
      listing_id: "5",
      expected_listing_revision: "1",
      expected_policy_revision: "2",
      unit_price: "12",
      command: active.args.command,
    }),
  );
  assert.equal(f.sends, 0);
});
