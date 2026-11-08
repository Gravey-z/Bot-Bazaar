import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { KeyPairEd25519, SignedTransaction, baseEncode } from "near-api-js";
import {
  FinalizedLivingTownReader,
  livingTownCommandDigest,
  verifyLivingTownReceipt,
} from "../../../../packages/chain/dist/index.js";
import { LivingTownCustomerDemand } from "../../dist/private/living-town/customers.js";
import { CustomerChainAdapter } from "../../dist/private/living-town/customer-chain.js";
import { DurableCustomerExecutor } from "../../dist/private/living-town/customer-executor.js";
import { LivingTownExecutionStore } from "../../dist/private/living-town/execution-store.js";

const capture = JSON.parse(
  readFileSync(
    "tests/fixtures/chain/living-town-customers-sandbox.json",
    "utf8",
  ),
);
const config = JSON.parse(readFileSync("config/living-town-v1.json", "utf8"));
const clone = (v) => structuredClone(v);
const foundation = capture.steps[0].foundation;
export const identity = {
  deployment: foundation.deployment,
  codeHash: capture.steps[0].account.code_hash,
  ownerId: foundation.data.owner_account_id,
  operatorId: foundation.data.operator_account_id,
  controllers: foundation.data.merchant_controllers,
};
export const continuity = async (context) => ({
  ...context,
  journal: "current",
  fencing: "verified",
  providerHistory: "accounted",
  evidenceRef: "controlled-test-continuity",
});

// Controlled RPC/chain model. Actual local signed bytes and SQLite, synthetic receipts.
// No network, provider, production credential or claim of additional WASM execution.
const openFixtures = new Map();
export function closeFixturesAt(dir) {
  for (const close of openFixtures.get(dir) ?? []) close();
  openFixtures.delete(dir);
}
export async function executionFixture(
  dir,
  { crashAt, continuityVerifier = continuity } = {},
) {
  const signer = KeyPairEd25519.fromRandom();
  const publicKey = (await signer.getPublicKey()).toString();
  const statePath = join(dir, "controlled-chain.json");
  let state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {
        town: clone(capture.before.town),
        shops: clone(capture.before.shops),
        sequence: "0",
        effect: null,
        receipt: null,
        nonce: "0",
        receipts: true,
        listings: [0, 1].map((i) => ({
          listing_id: String(5 + i),
          shop_id: String(4 + i),
          owner: clone(capture.before.shops[i].shop.data.owner),
          item_id: i === 0 ? "health_potion" : "iron_tool",
          remaining_quantity: "3",
          unit_price: i === 0 ? "18" : "24",
          revision: i === 0 ? "2" : "1",
          active: true,
        })),
      };
  const counts = { sign: 0, send: 0, status: 0 };
  const store = new LivingTownExecutionStore(
    dir,
    identity,
    "42",
    !existsSync(join(dir, "worker.sqlite")),
  );
  const demand = new LivingTownCustomerDemand(config);
  const pin = (data) => ({ ...clone(state.town), data: clone(data) });
  const block = () => ({
    hash: capture.before.block.header.hash,
    height: state.town.block_height,
    timestampNs: state.town.block_timestamp_ns,
  });
  const permission = {
    FunctionCall: {
      receiver_id: identity.deployment.contract_id,
      allowance: "10000000000000000000000",
      method_names: ["fund_customer_budget", "settle_customer_purchase"],
    },
  };
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  const die = (point) => {
    if (crashAt === point) {
      writeFileSync(
        join(dir, "crash-marker.json"),
        JSON.stringify({ point, counts }),
      );
      process.kill(process.pid, "SIGKILL");
    }
  };
  let mode = "success";
  async function execute(bytes) {
    const signed = SignedTransaction.decode(Buffer.from(bytes, "base64")),
      tx = signed.transaction,
      call = tx.actions[0].functionCall;
    const args = JSON.parse(Buffer.from(call.args).toString());
    const row = store.unresolved()[0];
    if (row?.status !== "unknown" || !row.signed_json)
      throw Error("broadcast preceded durable unknown marker");
    counts.send++;
    die("before_network");
    if (mode === "timeout_before_execution") throw Error("controlled timeout");
    const prepared = JSON.parse(row.signed_json);
    const digest = await livingTownCommandDigest(
      identity.deployment,
      identity.operatorId,
      prepared.call,
    );
    const template =
      call.methodName === "fund_customer_budget"
        ? capture.steps[5]
        : capture.steps[0];
    const effect = JSON.parse(
      Buffer.from(template.receipt.status.SuccessValue, "base64").toString(),
    );
    effect.block_height = state.town.block_height;
    effect.block_timestamp_ns = state.town.block_timestamp_ns;
    effect.market_revision = effect.event_sequence = (
      BigInt(state.town.market_revision) + 1n
    ).toString();
    Object.assign(effect.data, {
      command_sequence: args.command.sequence,
      payload_sha256: digest,
      effect_revision: effect.market_revision,
      effect_event_sequence: effect.event_sequence,
    });
    const pool = clone(state.town.data.customer_pool);
    pool.revision = (BigInt(pool.revision) + 1n).toString();
    if (call.methodName === "fund_customer_budget") {
      const issued =
        200n - BigInt(pool.gold) < 100n ? 200n - BigInt(pool.gold) : 100n;
      pool.gold = (BigInt(pool.gold) + issued).toString();
      pool.last_funded_epoch = args.epoch;
      effect.data.outcome = {
        kind: "customer_funded",
        epoch: args.epoch,
        issued_gold: issued.toString(),
        pool,
      };
    } else {
      const listing = state.listings.find(
          (l) => l.listing_id === args.listing_id,
        ),
        i = Number(listing.shop_id) - 4;
      const out = effect.data.outcome;
      out.listing = clone(listing);
      out.listing.remaining_quantity = (
        BigInt(listing.remaining_quantity) - 1n
      ).toString();
      out.listing.revision = (BigInt(listing.revision) + 1n).toString();
      out.listing.active = out.listing.remaining_quantity !== "0";
      out.seller = clone(state.shops[i].ledger.data);
      out.seller.gold.held = out.seller.gold.available = (
        BigInt(out.seller.gold.held) + BigInt(listing.unit_price)
      ).toString();
      out.seller.revision = (BigInt(out.seller.revision) + 1n).toString();
      out.seller.inventory.held[listing.item_id] =
        out.seller.inventory.listing_reserved[listing.item_id] =
          out.listing.remaining_quantity;
      Object.assign(out.trade, {
        item_id: listing.item_id,
        seller: clone(listing.owner),
        listing_id: listing.listing_id,
        unit_price: listing.unit_price,
        total_price: listing.unit_price,
        settled_at_ns: effect.block_timestamp_ns,
        command_sequence: args.command.sequence,
        event_sequence: effect.event_sequence,
      });
      pool.gold = (BigInt(pool.gold) - BigInt(listing.unit_price)).toString();
      const key =
        listing.item_id === "health_potion"
          ? "potion_units_bought"
          : "tool_units_bought";
      pool[key] = String(Number(pool[key]) + 1);
      out.pool = pool;
      state.listings[i] = out.listing;
      state.shops[i].ledger.data = out.seller;
    }
    state.sequence = args.command.sequence;
    state.effect = effect;
    state.nonce = tx.nonce.toString();
    state.town.data.customer_pool = pool;
    state.town.market_revision = state.town.event_sequence =
      effect.market_revision;
    for (const s of state.shops)
      for (const k of ["shop", "ledger"])
        Object.assign(s[k], {
          market_revision: effect.market_revision,
          event_sequence: effect.event_sequence,
        });
    const receipt = clone(template.receipt);
    Object.assign(receipt.transaction, {
      hash: prepared.transactionHash,
      nonce: tx.nonce.toString(),
      public_key: tx.publicKey.toString(),
      signer_id: tx.signerId,
      receiver_id: tx.receiverId,
      signature: `ed25519:${baseEncode(Uint8Array.from(signed.signature.ed25519Signature.data))}`,
      actions: [
        {
          FunctionCall: {
            method_name: call.methodName,
            args: Buffer.from(call.args).toString("base64"),
            deposit: "0",
            gas: call.gas.toString(),
          },
        },
      ],
    });
    receipt.transaction_outcome.id = prepared.transactionHash;
    receipt.status.SuccessValue = Buffer.from(JSON.stringify(effect)).toString(
      "base64",
    );
    const root = receipt.transaction_outcome.outcome.status.SuccessReceiptId;
    const executed = receipt.receipts_outcome.find((r) => r.id === root);
    executed.outcome.status.SuccessValue = receipt.status.SuccessValue;
    executed.block_hash = block().hash;
    state.receipt = receipt;
    save();
    die("after_network");
    if (mode === "timeout_after_execution")
      throw Error("controlled post-execution timeout");
    return { transaction: { hash: prepared.transactionHash } };
  }
  const adapter = new CustomerChainAdapter(
    identity,
    async (method, args) => {
      if (method !== "send_tx") throw Error(`unexpected RPC ${method}`);
      try {
        return await execute(args.signed_tx_base64);
      } catch (error) {
        counts.lastError = error.message;
        throw error;
      }
    },
    {
      publicKey,
      loadSecretKey: async () => {
        counts.sign++;
        if (store.unresolved()[0]?.status !== "prepared")
          throw Error("credential loaded before intent persistence");
        die("before_sign");
        // Test-only key, exported by the test signer; never a workspace credential.
        return signer.toString();
      },
    },
  );
  adapter.client.finalized = async () =>
    new FinalizedLivingTownReader(
      async (_method, args) => {
        let data;
        if (args.request_type === "view_access_key")
          return {
            block_hash: block().hash,
            block_height: block().height,
            nonce: state.nonce,
            permission,
          };
        const fields = JSON.parse(
          Buffer.from(args.args_base64, "base64").toString(),
        );
        if (args.method_name === "get_town")
          return {
            block_hash: block().hash,
            block_height: block().height,
            result: [...Buffer.from(JSON.stringify(state.town))],
          };
        if (args.method_name === "get_command") {
          const op = fields.principal === `account:${identity.operatorId}`;
          const sequence = op ? state.sequence : "0";
          data =
            BigInt(fields.sequence) > BigInt(sequence)
              ? {
                  kind: "not_applied",
                  high_water: sequence,
                  next_sequence: (BigInt(sequence) + 1n).toString(),
                }
              : fields.sequence === sequence && state.effect
                ? {
                    kind: "found",
                    high_water: sequence,
                    method:
                      state.effect.data.outcome.kind === "customer_funded"
                        ? "fund_customer_budget"
                        : "settle_customer_purchase",
                    payload_sha256: state.effect.data.payload_sha256,
                    effect: state.effect.data,
                  }
                : {
                    kind: "pruned",
                    high_water: sequence,
                    sequence: fields.sequence,
                  };
        } else if (args.method_name === "get_listings")
          data = {
            items: state.listings.filter((l) => l.shop_id === fields.shop_id),
            next_after_id:
              state.listings.filter((l) => l.shop_id === fields.shop_id).at(-1)
                ?.listing_id ?? null,
            has_more: false,
            history_gap: false,
            pruned_through: "0",
          };
        else if (args.method_name === "get_shop")
          data = state.shops[Number(fields.shop_id) - 4].shop.data;
        else if (args.method_name === "get_shop_inventory")
          data = state.shops[Number(fields.shop_id) - 4].ledger.data;
        else throw Error(`unexpected view ${args.method_name}`);
        return {
          block_hash: block().hash,
          block_height: block().height,
          result: [...Buffer.from(JSON.stringify(pin(data)))],
        };
      },
      identity,
      block(),
    );
  adapter.client.receipt = async (proof) => {
    counts.status++;
    if (!state.receipts || !state.receipt)
      return { kind: "unknown", transactionHash: proof.transactionHash };
    const verified = await verifyLivingTownReceipt(
      state.receipt,
      proof,
      async () => block(),
    );
    return verified;
  };
  const originalSave = store.saveSigned.bind(store);
  store.saveSigned = (...args) => {
    originalSave(...args);
    die("after_signed");
  };
  const originalBroadcast = store.markBroadcast.bind(store);
  store.markBroadcast = (...args) => {
    originalBroadcast(...args);
    if (args[1] === "unknown") die("after_unknown");
    if (args[1] === "submitted") die("after_submission");
  };
  const originalResolve = store.resolve.bind(store);
  store.resolve = (...args) => {
    // Executor has authenticated the receipt or matching command checkpoint;
    // die before its terminal journal update, rather than inventing a receipt.
    die("after_confirmation");
    return originalResolve(...args);
  };
  const processor = new DurableCustomerExecutor(
    store,
    demand,
    adapter,
    continuityVerifier,
  );
  const input = () => ({
    town: clone(state.town),
    seed: "42",
    tick: state.town.data.epoch,
    arrivalIndex: "0",
    fresh: true,
    marketComplete: true,
    historyComplete: true,
    candidates: state.listings.map((l, i) => ({
      listing: clone(l),
      shop: clone(state.shops[i].shop),
      ledger: clone(state.shops[i].ledger),
      lastSaleEventSequence: null,
    })),
  });
  const close = () => store.close();
  if (!openFixtures.has(dir)) openFixtures.set(dir, []);
  openFixtures.get(dir).push(close);
  return {
    store,
    processor,
    adapter,
    demand,
    counts,
    input,
    state,
    permission,
    save,
    mode: (value) => {
      mode = value;
    },
    close: () => store.close(),
  };
}
