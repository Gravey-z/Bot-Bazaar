import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createAssistantServer } from "../dist/private/assistant/server.js";
import { AssistantAuthError } from "../dist/private/assistant/auth.js";
import { AssistantStore } from "../dist/private/assistant/store.js";
import {
  AssistantAudit,
  manualAssistantAudit,
} from "../dist/private/assistant/audit.js";
import {
  assistantManualReview,
  assistantAuditReceiptUrl,
  canonicalLivingTownJson,
  createLivingTownCall,
  livingTownJsonDigest,
  verifyLivingTownReceipt,
} from "@bot-bazaar/chain";
const capture = JSON.parse(
  readFileSync("tests/fixtures/chain/living-town-sandbox.json", "utf8"),
);
const s = capture.steps[3];
const effect = JSON.parse(Buffer.from(s.receipt.status.SuccessValue, "base64"));
const foundation = JSON.parse(Buffer.from(s.foundation.result, "base64"));
const identity = {
  deployment: foundation.deployment,
  codeHash: s.account.code_hash,
  ownerId: capture.contract_id,
  operatorId: "operator.testnet",
  controllers: {
    rex: "rex.testnet",
    luna: "luna.testnet",
    bolt: "bolt.testnet",
  },
};
const hash = (value) =>
  createHash("sha256").update(canonicalLivingTownJson(value)).digest("hex");
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-audit-"));
  let store = new AssistantStore(dir, canonicalLivingTownJson(identity), true);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account = s.receipt.transaction.signer_id,
    shop = "4",
    attempt = "11111111-1111-4111-8111-111111111111";
  store.configure(account, shop, "recommendations");
  const call = createLivingTownCall(s.method, s.args);
  const terms = {
    schema: "living-town-assistant-proposal-v1",
    shop_id: shop,
    owner_account_id: account,
    snapshot: {
      deployment: identity.deployment,
      block_hash: s.block.header.hash,
      block_height: String(s.block.header.height),
      block_timestamp_ns: s.block.header.timestamp_nanosec,
      market_revision: effect.market_revision,
      event_sequence: effect.event_sequence,
    },
    expected_shop_revision: "1",
    expected_ledger_revision: "1",
    expected_policy_revision: "1",
    config_revision: "2",
    created_at_ns: s.block.header.timestamp_nanosec,
    expires_at_ns: call.args.command.valid_until_ns,
    source: "rules_fallback",
    action: {
      type: "suggest_restock",
      item_id: call.args.item_id,
      listing_id: effect.data.outcome.listing.listing_id,
      expected_listing_revision: call.args.expected_listing_revision,
      seller_shop_id: "1",
      quantity: call.args.quantity,
      unit_price: effect.data.outcome.listing.unit_price,
      total_price: call.args.max_total_price,
    },
    reason: "Controlled receipt-backed restock review",
  };
  const proposal = { ...terms, proposal_id: await livingTownJsonDigest(terms) };
  const { command: _, ...args } = call.args;
  void _;
  const body = {
    schema: "living-town-assistant-review-v1",
    proposal,
    call: { method: call.method, args },
  };
  const review = assistantManualReview({
    ...body,
    review_id: await livingTownJsonDigest(body),
  });
  const request = "a".repeat(64),
    now = Date.now();
  store.begin({
    id: request,
    account,
    shop,
    context: "controlled",
    revision: "2",
    status: "pending",
    code: "admitted",
    proposals: [],
    started: now,
    updated: now,
  });
  store.finish(request, "proposed", "provider_not_configured", [proposal], now);
  let response = s.receipt,
    reads = 0;
  const client = {
    identity,
    async receipt(proof) {
      reads++;
      return verifyLivingTownReceipt(response, proof, async () => ({
        hash: s.block.header.hash,
        height: String(s.block.header.height),
        timestampNs: s.block.header.timestamp_nanosec,
      }));
    },
  };
  const audit = () => new AssistantAudit(store, client);
  return {
    get store() {
      return store;
    },
    account,
    shop,
    attempt,
    proposal,
    review,
    call,
    audit,
    client,
    get reads() {
      return reads;
    },
    set response(value) {
      response = value;
    },
    accept() {
      store.saveReview(account, shop, review);
      store.claimReview(
        account,
        shop,
        proposal.proposal_id,
        attempt,
        hash(call),
        call,
      );
    },
    report: () =>
      audit().outcome(
        account,
        shop,
        proposal.proposal_id,
        attempt,
        s.transaction_hash,
        String(s.reference_block_height),
      ),
    reopen() {
      store.close();
      store = new AssistantStore(dir, canonicalLivingTownJson(identity));
    },
  };
}
test("audit keeps proposal, review and acceptance distinct from verified confirmation across restart", async (t) => {
  const f = await fixture(t);
  const row = () => manualAssistantAudit(f.store, f.account, f.shop)[0];
  assert.equal(row().acceptance, "none");
  assert.equal(row().validation, "validated");
  f.store.saveReview(f.account, f.shop, f.review);
  assert.equal(row().acceptance, "reviewed");
  f.accept();
  assert.equal(row().acceptance, "accepted");
  assert.equal(row().outcome, "unknown");
  assert.equal(assistantAuditReceiptUrl(row()), null);
  await f.report();
  assert.equal(row().outcome, "confirmed");
  assert.ok(row().receipt_id);
  assert.ok(row().accepted_at_ms);
  assert.equal(row().policy_revision, "1");
  assert.match(
    assistantAuditReceiptUrl(row()),
    /^https:\/\/testnet.nearblocks.io\/txns\//,
  );
  const before = row();
  f.reopen();
  assert.deepEqual(row(), before);
});
test("unaccepted, cross-shop and other-owner reports cannot trigger receipt lookups", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.report());
  f.accept();
  for (const [account, shop, attempt] of [
    ["mallory.testnet", f.shop, f.attempt],
    [f.account, "5", f.attempt],
    [f.account, f.shop, "22222222-2222-4222-8222-222222222222"],
  ]) {
    await assert.rejects(
      f
        .audit()
        .outcome(
          account,
          shop,
          f.proposal.proposal_id,
          attempt,
          s.transaction_hash,
          String(s.reference_block_height),
        ),
    );
  }
  assert.equal(f.reads, 0);
  assert.throws(() => manualAssistantAudit(f.store, "mallory.testnet", f.shop));
});
test("unknown and pending proofs have no receipt link and cannot downgrade final confirmation", async (t) => {
  const f = await fixture(t);
  f.accept();
  f.response = { final_execution_status: "NONE" };
  await f.report();
  let row = manualAssistantAudit(f.store, f.account, f.shop)[0];
  assert.equal(row.outcome, "unknown");
  assert.equal(assistantAuditReceiptUrl(row), null);
  f.response = { ...s.receipt, final_execution_status: "INCLUDED" };
  await f.report();
  row = manualAssistantAudit(f.store, f.account, f.shop)[0];
  assert.equal(row.outcome, "submitted");
  f.response = s.receipt;
  await f.report();
  f.response = { final_execution_status: "NONE" };
  await f.report();
  assert.equal(
    manualAssistantAudit(f.store, f.account, f.shop)[0].outcome,
    "confirmed",
  );
});
test("forged receipt hash and altered transaction terms never produce confirmed audit", async (t) => {
  const f = await fixture(t);
  f.accept();
  await assert.rejects(
    f
      .audit()
      .outcome(
        f.account,
        f.shop,
        f.proposal.proposal_id,
        f.attempt,
        "11111111111111111111111111111111",
        String(s.reference_block_height),
      ),
  );
  const changed = structuredClone(s.receipt);
  changed.transaction.receiver_id = "other.testnet";
  f.response = changed;
  await assert.rejects(f.report());
  assert.equal(
    manualAssistantAudit(f.store, f.account, f.shop)[0].outcome,
    "unknown",
  );
});
test("audit composition rejects mismatched deployment identities", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      new AssistantAudit(f.store, {
        identity: { ...identity, operatorId: "other.testnet" },
      }),
  );
  assert.throws(
    () =>
      new AssistantAudit(f.store, f.client, {
        identity: { ...identity, codeHash: "11111111111111111111111111111111" },
      }),
  );
});
test("private audit route enforces owner scope and rejects supplied status, receipt URL and public aliases", async (t) => {
  const f = await fixture(t);
  f.accept();
  const auth = {
    origin: "https://bazaar.example",
    async scope(token, shop) {
      if (token !== "a".repeat(43) || shop !== f.shop)
        throw new AssistantAuthError(401);
      return { accountId: f.account, shopId: shop };
    },
  };
  const server = createAssistantServer(auth, {
    outcome: async (...args) => {
      await f.audit().outcome(...args);
      return { recorded: true };
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const body = {
    proposalId: f.proposal.proposal_id,
    attemptId: f.attempt,
    transactionHash: s.transaction_hash,
    referenceBlockHeight: String(s.reference_block_height),
  };
  const request = (path, payload = body, token = "a".repeat(43)) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST",
      headers: {
        Origin: auth.origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  const path = `/private/assistant/shops/${f.shop}/outcome`;
  assert.equal((await request(path, body, "bad")).status, 401);
  assert.equal(
    (await request("/private/assistant/shops/5/outcome")).status,
    401,
  );
  for (const extra of [
    { status: "confirmed" },
    { receiptUrl: "https://attacker.example" },
    { accountId: f.account },
  ])
    assert.equal((await request(path, { ...body, ...extra })).status, 400);
  assert.equal((await request("/assistant/shops/4/outcome")).status, 404);
  assert.equal(f.reads, 0);
  assert.equal((await request(path)).status, 200);
  assert.equal(f.reads, 1);
});
