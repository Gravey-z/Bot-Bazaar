import { boundedTownRpc } from "../apps/worker/dist/private/living-town/runtime-rpc.js";
// Dedicated operator-controlled Testnet preparation. This does not exercise browser-wallet UX.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LivingTownClient,
  createRpcTransport,
  createLivingTownCall,
  createLivingTownCompletionCall,
} from "../packages/chain/dist/index.js";
const require = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
);
const {
  KeyPairSigner,
  PublicKey,
  createTransaction,
  baseDecode,
  baseEncode,
  actions,
} = require("near-api-js");
const args = process.argv.slice(2);
assert(
  args.length === 4 &&
    args[0] === "--key-file" &&
    isAbsolute(args[1]) &&
    args[2] === "--phase" &&
    [
      "prepare",
      "list",
      "buy-again",
      "react",
      "react-follow-up",
      "react-windowed",
    ].includes(args[3]),
  "Use --key-file <absolute-prepared-player.json> --phase prepare|list|buy-again",
);
const profile = JSON.parse(
  await readFile(
    new URL("../config/living-town-testnet.json", import.meta.url),
    "utf8",
  ),
);
const account = `player.${profile.identity.ownerId}`;
const rpc = boundedTownRpc(createRpcTransport(profile.public.rpcUrl));
const client = new LivingTownClient(profile.identity, rpc);
await client.finalized();
const key = JSON.parse(await readFile(args[1], "utf8"));
assert.equal(key.account_id, account);
const signer = KeyPairSigner.fromSecretKey(key.private_key);
assert.equal((await signer.getPublicKey()).toString(), key.public_key);
const directory = fileURLToPath(
  new URL("../data/day02-player-smoke/", import.meta.url),
);
const outbox = fileURLToPath(new URL("../data/day02-outbox/", import.meta.url));
await mkdir(directory, { recursive: true });
await mkdir(outbox, { recursive: true });

async function execute(stage, method, input = {}) {
  const filename = join(directory, `${stage}.json`);
  let original;
  try {
    original = JSON.parse(await readFile(filename, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (original) {
    try {
      const prior = JSON.parse(
        await readFile(join(directory, `${stage}-result.json`), "utf8"),
      );
      assert.equal(prior.kind, "succeeded");
      assert.equal(prior.transactionHash, original.proof.transactionHash);
      console.log(
        JSON.stringify({
          stage,
          transactionHash: prior.transactionHash,
          result: prior.kind,
          source: "previously_verified_receipt",
        }),
      );
      return prior;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (!original) {
    const reader = await client.finalized(),
      town = await reader.getTown();
    const command = await reader.getCommand(account, "18446744073709551615");
    const call =
      method === "complete_production"
        ? createLivingTownCompletionCall(input)
        : createLivingTownCall(method, {
            ...input,
            command: {
              sequence: command.data.next_sequence,
              config_version: "1",
              valid_until_ns: (
                BigInt(town.block_timestamp_ns) + 60000000000n
              ).toString(),
            },
          });
    const access = await reader.getAccessKey(account, key.public_key);
    assert.equal(access.permission, "FullAccess");
    const tx = createTransaction(
      account,
      PublicKey.fromString(key.public_key),
      profile.public.contractId,
      BigInt(access.nonce) + 1n,
      [actions.functionCall(method, call.args, 30000000000000n, 0n)],
      baseDecode(reader.block.hash),
    );
    const signed = await signer.signTransaction(tx);
    original = {
      proof: {
        transactionHash: baseEncode(signed.txHash),
        signerId: account,
        deployment: profile.identity.deployment,
        call,
        gas: "30000000000000",
        referenceBlockHeight: reader.block.height,
      },
      signed: Buffer.from(signed.signedTransaction.encode()).toString("base64"),
      state: "unknown_before_broadcast",
    };
    await writeFile(filename, JSON.stringify(original), {
      flag: "wx",
      mode: 0o600,
    });
    // Exactly one send per stage. On timeout/restart only this original proof is queried.
    await rpc("send_tx", {
      signed_tx_base64: original.signed,
      wait_until: "INCLUDED",
    });
  }
  let result;
  for (let n = 0; n < 15; n++) {
    result = await (method === "complete_production"
      ? client.completionReceipt(original.proof)
      : client.receipt(original.proof));
    if (["succeeded", "failed"].includes(result.kind)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(
    result.kind,
    "succeeded",
    "original player transaction has not succeeded; reconcile it before continuing",
  );
  await writeFile(
    join(directory, `${stage}-result.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
  const p = original.proof;
  const publicProof = {
    transaction_hash: p.transactionHash,
    signer_id: p.signerId,
    method: p.call.method,
    args: p.call.args,
    reference_block_height: p.referenceBlockHeight,
    gas: p.gas,
  };
  try {
    await writeFile(
      join(outbox, `${p.transactionHash}.json`),
      JSON.stringify({
        schema: "living-town-receipt-inbox-v1",
        requests: [publicProof],
      }) + "\n",
      { flag: "wx" },
    );
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  console.log(
    JSON.stringify({
      stage,
      transactionHash: p.transactionHash,
      result: result.kind,
    }),
  );
  return result;
}
async function shop() {
  const reader = await client.finalized(),
    player = await reader.getPlayer(account);
  assert(player.data?.shop_id, "prepared player shop required");
  return { reader, player, shop: await reader.getShop(player.data.shop_id) };
}
async function buy(stage, item, merchant, quantity) {
  const reader = await client.finalized(),
    town = await reader.getTown();
  const listings = await reader.getListings({
    shop_id: merchant === "rex" ? "1" : "2",
    item_id: item,
    active_only: true,
    after_id: null,
    limit: "50",
    expected_market_revision: town.market_revision,
  });
  const listing = listings.data.items[0];
  assert(
    listing && BigInt(listing.remaining_quantity) >= BigInt(quantity),
    "supplier stock not yet replenished",
  );
  return execute(stage, "buy_from_merchant", {
    merchant_id: merchant,
    item_id: item,
    quantity,
    expected_listing_revision: listing.revision,
    max_total_price: (BigInt(listing.unit_price) * BigInt(quantity)).toString(),
  });
}
if (args[3] === "prepare") {
  await execute("register", "register_player");
  await execute("shop", "create_shop", { name: "Runtime Smoke" });
  await buy("crystal", "crystal", "rex", "1");
  await buy("herb", "herb", "luna", "2");
  const s = await shop();
  await execute("produce-potion", "start_production", {
    shop_id: s.shop.data.shop_id,
    recipe_id: "health_potion",
    recipe_version: "1",
    quantity: "1",
    expected_shop_revision: s.shop.data.revision,
  });
} else if (args[3] === "list") {
  const s = await shop(),
    town = await s.reader.getTown();
  const jobs = await s.reader.getProductionJobs({
    shop_id: s.shop.data.shop_id,
    status: "all",
    after_id: null,
    limit: "50",
    expected_market_revision: town.market_revision,
  });
  const job = jobs.data.items.find((j) => j.recipe_id === "health_potion");
  assert(job, "potion production job required");
  assert(
    BigInt(job.ready_at_ns) <= BigInt(town.block_timestamp_ns),
    "the genuine 120-second production timer is still running",
  );
  await execute("complete-potion", "complete_production", {
    job_id: job.job_id,
  });
  await execute("list-potion", "set_listing", {
    shop_id: s.shop.data.shop_id,
    item_id: "health_potion",
    quantity: "1",
    unit_price: "18",
    expected_listing_revision: null,
  });
} else if (args[3] === "react") {
  await buy("day03-herb-trigger", "herb", "luna", "1");
} else if (args[3] === "react-follow-up") {
  await buy("day03-herb-trigger-follow-up", "herb", "luna", "1");
} else if (args[3] === "react-windowed") {
  await buy("day03-herb-trigger-windowed", "herb", "luna", "1");
} else {
  await buy("herb-after-replenishment", "herb", "luna", "1");
}
