import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Read-only audit for the first Bot Bazaar deployment. It deliberately requires
// the untouched seed; later economic evidence belongs to the P2.21 run.
const contract = "vaultkeeper-bazaar.testnet";
const controllers = {
  rex: "rex-bazaar.testnet",
  luna: "luna-bazaar.testnet",
  bolt: "bolt-bazaar.testnet",
};
const player = "player-bazaar.testnet";
const methods = [
  "set_listing",
  "propose_trade",
  "accept_trade",
  "cancel_trade",
  "expire_offers",
];
const rpcUrl = "https://test.rpc.fastnear.com";
async function callRpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "p220", method, params }),
    signal: AbortSignal.timeout(25_000),
  });
  assert.ok(response.ok, `RPC ${method}: HTTP ${response.status}`);
  const body = await response.json();
  assert.ok(
    !body.error && body.result,
    `RPC ${method} failed: ${body.error?.data ?? "no result"}`,
  );
  return body.result;
}

function parseArguments() {
  const [mode, outputPath, wasmPath] = process.argv.slice(2);
  assert.ok(
    ["preflight", "deployed"].includes(mode) && outputPath,
    "Usage: node scripts/verify-testnet-deployment.mjs <preflight|deployed> <evidence.json> [wasm-file]",
  );
  return { mode, outputPath, wasmPath };
}

async function createFinalizedReader() {
  const status = await callRpc("status", {});
  assert.equal(status.chain_id, "testnet");
  assert.equal(status.sync_info.syncing, false);
  const block = await callRpc("block", { finality: "final" });
  const blockId = block.header.hash;
  async function query(request_type, account_id, extra = {}) {
    const result = await callRpc("query", {
      request_type,
      account_id,
      block_id: blockId,
      ...extra,
    });
    assert.equal(result.block_hash, blockId);
    return result;
  }
  async function view(method_name, args = {}) {
    const result = await query("call_function", contract, {
      method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    const snapshot = JSON.parse(Buffer.from(result.result).toString("utf8"));
    assert.equal(snapshot.block_height, String(block.header.height));
    assert.equal(snapshot.market_revision, "1");
    return snapshot;
  }
  return { status, block, query, view };
}

async function readAccounts(query, mode) {
  const accounts = {};
  for (const id of [contract, ...Object.values(controllers), player]) {
    const [account, keys] = await Promise.all([
      query("view_account", id),
      query("view_access_key_list", id),
    ]);
    assert.ok(
      BigInt(account.amount) > 10n ** 23n,
      `${id}: insufficient balance`,
    );
    assert.equal(
      keys.keys.filter((k) => k.access_key.permission === "FullAccess").length,
      1,
      `${id}: expected one recovery key`,
    );
    if (mode === "preflight") {
      assert.equal(
        account.code_hash,
        "11111111111111111111111111111111",
        `${id}: unexpected existing code`,
      );
      assert.equal(keys.keys.length, 1, `${id}: unexpected existing keys`);
    }
    accounts[id] = { account, keys: keys.keys };
  }
  return accounts;
}

async function readFundingBudget(accounts, blockId) {
  const [config, gasPrice] = await Promise.all([
    callRpc("EXPERIMENTAL_protocol_config", { block_id: blockId }),
    callRpc("gas_price", [blockId]),
  ]);
  const byteCost = BigInt(config.runtime_config.storage_amount_per_byte);
  const fullCapacityStake = 516667n * byteCost;
  const fullCapacityBudget = fullCapacityStake + (fullCapacityStake + 3n) / 4n;
  assert.ok(
    BigInt(accounts[contract].account.amount) >= fullCapacityBudget,
    "Contract lacks full-capacity storage funding/headroom",
  );
  return { config, gasPrice, byteCost, fullCapacityBudget };
}

async function verifyDeployedCode(query, wasmPath) {
  assert.ok(wasmPath, "deployed mode requires the local WASM");
  const local = await readFile(wasmPath);
  const code = await query("view_code", contract);
  const deployed = Buffer.from(code.code_base64, "base64");
  assert.deepEqual(
    deployed,
    local,
    "Deployed code differs from the local artifact",
  );
  return {
    wasm_bytes: local.length,
    wasm_sha256: createHash("sha256").update(local).digest("hex"),
    code_hash: code.hash,
  };
}

function assertRuntimeKeys(accounts) {
  for (const id of Object.values(controllers)) {
    const runtime = accounts[id].keys.filter(
      (k) => k.access_key.permission !== "FullAccess",
    );
    assert.equal(runtime.length, 1, `${id}: expected one runtime key`);
    const permission = runtime[0].access_key.permission.FunctionCall;
    assert.equal(permission.receiver_id, contract);
    assert.equal(permission.allowance, "100000000000000000000000");
    assert.deepEqual([...permission.method_names].sort(), [...methods].sort());
  }
}

async function readVerifiedSeed(view) {
  const evidence = {};
  evidence.market_state = await view("get_market_state");
  const market = evidence.market_state.data;
  assert.equal(market.contract_account_id, contract);
  assert.equal(market.owner_account_id, contract);
  assert.equal(market.api_version, "1.0.0");
  assert.equal(market.economy_version, "1");
  assert.equal(market.paused, false);
  assert.equal(market.registered_player_count, "0");
  assert.equal(market.total_issued_gold, "550");
  assert.deepEqual(market.resource_supply, {
    crystal: "29",
    wood: "25",
    herb: "26",
    iron: "24",
  });
  for (const field of ["next_offer_id", "next_trade_id"])
    assert.equal(market[field], "1");
  for (const field of ["offers_pruned_through", "trades_pruned_through"])
    assert.equal(market[field], "0");
  const resources = ["crystal", "wood", "herb", "iron"];
  const seeds = [
    {
      id: "rex",
      gold: "180",
      inventory: [15, 4, 2, 10],
      prices: [4, 3, 4, 5],
      quantities: [15, 2, 0, 6],
    },
    {
      id: "luna",
      gold: "220",
      inventory: [12, 3, 20, 2],
      prices: [6, 3, 3, 6],
      quantities: [8, 1, 12, 0],
    },
    {
      id: "bolt",
      gold: "150",
      inventory: [2, 18, 4, 12],
      prices: [7, 2, 4, 5],
      quantities: [0, 10, 2, 6],
    },
  ];
  assert.equal(market.merchants.length, seeds.length);
  evidence.offer_pages = {};
  for (const [index, seed] of seeds.entries()) {
    const { id, gold, inventory, prices, quantities } = seed;
    const merchant = market.merchants[index];
    assert.equal(merchant.merchant_id, id);
    assert.equal(merchant.controller_account_id, controllers[id]);
    assert.equal(merchant.gold, gold);
    assert.equal(merchant.last_action_id, "0");
    assert.equal(merchant.last_action, null);
    assert.deepEqual(
      merchant.inventory,
      Object.fromEntries(resources.map((r, i) => [r, String(inventory[i])])),
    );
    assert.deepEqual(
      merchant.listings,
      resources.map((resource, i) => ({
        merchant_id: id,
        resource,
        unit_price: String(prices[i]),
        quantity: String(quantities[i]),
        active: quantities[i] > 0,
        version: "1",
      })),
    );
    assert.deepEqual(
      (await view("get_merchant", { merchant_id: id })).data,
      merchant,
    );
    const page = await view("get_offers_for_merchant", {
      merchant_id: id,
      status: "all",
      after_id: null,
      limit: "50",
      expected_revision: "1",
    });
    assert.deepEqual(page.data.items, []);
    evidence.offer_pages[id] = page;
  }
  evidence.player = await view("get_player", { account_id: player });
  assert.equal(evidence.player.data, null);
  evidence.trades = await view("get_recent_trades", {
    after_id: null,
    limit: "50",
    expected_revision: "1",
  });
  assert.deepEqual(evidence.trades.data.items, []);
  return evidence;
}

async function main() {
  const { mode, outputPath, wasmPath } = parseArguments();
  const { status, block, query, view } = await createFinalizedReader();
  const blockId = block.header.hash;
  const accounts = await readAccounts(query, mode);
  const { config, gasPrice, byteCost, fullCapacityBudget } =
    await readFundingBudget(accounts, block.header.hash);
  const evidence = {
    checked_at_utc: new Date().toISOString(),
    mode,
    rpc_url: rpcUrl,
    chain_id: status.chain_id,
    finalized_block: {
      hash: blockId,
      height: block.header.height,
      timestamp_ns: block.header.timestamp_nanosec,
    },
    protocol_version: config.protocol_version,
    storage_amount_per_byte: byteCost.toString(),
    gas_price: gasPrice.gas_price,
    contract_account_id: contract,
    owner_account_id: contract,
    merchant_controllers: controllers,
    player_account_id: player,
    full_capacity_bytes: "516667",
    full_capacity_funding_with_25_percent_headroom:
      fullCapacityBudget.toString(),
    accounts,
  };

  if (mode === "deployed") {
    Object.assign(evidence, await verifyDeployedCode(query, wasmPath));
    assertRuntimeKeys(accounts);
    Object.assign(evidence, await readVerifiedSeed(view));
  }
  // Contains public chain evidence only; no access to the system keychain.
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      verified: mode,
      block: blockId,
      output: outputPath,
      storage_bytes: accounts[contract].account.storage_usage,
      wasm_sha256: evidence.wasm_sha256,
    }),
  );
}

await main();
