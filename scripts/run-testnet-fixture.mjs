import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// One-time, operator-driven P2.21 fixture, with no provider/model integration.
// An interrupted run must be reconciled from its journal, never blindly restarted.
const requireWorkerDependency = createRequire(
  new URL("../apps/worker/package.json", import.meta.url),
);
const { SignedTransaction, baseEncode } =
  requireWorkerDependency("near-api-js");
const contract = "vaultkeeper-bazaar.testnet";
const player = "player-bazaar.testnet";
const rpcUrl = "https://test.rpc.fastnear.com";
const codeHash = "CcU8qzpFzXy9BstkGqLCnK7Uxam8tymqZyaDK92nzYkW";
const actors = {
  player: {
    id: player,
    key: "ed25519:ERxgBSZ7uZE5Q54iJzb3QrW1tkpwvanB99PftDYGgJJD",
  },
  rex: {
    id: "rex-bazaar.testnet",
    key: "ed25519:5HH4zzYch19VWfAAh2pMJWGZvPnfgUuGnmQtnWF1g1hx",
  },
  luna: {
    id: "luna-bazaar.testnet",
    key: "ed25519:32mf2USaRbubhuxKYorrWsjSeiavshMENcdTTt2nYLXd",
  },
};
const actorIndex = { rex: 0, luna: 1, bolt: 2, player: 3 };
const resources = ["crystal", "wood", "herb", "iron"];
const runtimeMethods = [
  "set_listing",
  "propose_trade",
  "accept_trade",
  "cancel_trade",
  "expire_offers",
];
const evidenceDir = resolve("../Bot Bazaar docks/docs/evidence");
const privateDir = resolve("target/phase-02-fixture");
const evidencePath = join(evidenceDir, "phase-02-real-calls.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function writeJson(filePath, value, exclusive = false) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: exclusive ? "wx" : "w",
  });
}
async function callRpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "p221", method, params }),
    signal: AbortSignal.timeout(45_000),
  });
  assert.ok(
    response.ok,
    `RPC ${method} HTTP ${response.status}; preserve the journal`,
  );
  const body = await response.json();
  assert.ok(
    body.result && !body.error,
    `RPC ${method}: ${JSON.stringify(body.error)}; reconcile before continuing`,
  );
  return body.result;
}
async function readMarketSnapshot(expectedRevision) {
  const status = await callRpc("status", {});
  assert.equal(status.chain_id, "testnet");
  assert.equal(status.sync_info.syncing, false);
  const block = await callRpc("block", { finality: "final" });
  const block_id = block.header.hash;
  async function query(request_type, account_id, extra = {}) {
    const result = await callRpc("query", {
      request_type,
      account_id,
      block_id,
      ...extra,
    });
    assert.equal(result.block_hash, block_id);
    return result;
  }
  async function view(method_name, args = {}) {
    const result = await query("call_function", contract, {
      method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    const value = JSON.parse(Buffer.from(result.result).toString("utf8"));
    assert.equal(value.market_revision, expectedRevision);
    assert.equal(value.block_height, String(block.header.height));
    return value;
  }
  const account = await query("view_account", contract);
  assert.equal(account.code_hash, codeHash);
  const market = await view("get_market_state");
  assert.equal(market.data.contract_account_id, contract);
  assert.equal(market.data.owner_account_id, contract);
  assert.equal(market.data.paused, false);
  for (const [index, id] of ["rex", "luna", "bolt"].entries()) {
    assert.equal(market.data.merchants[index].merchant_id, id);
    assert.equal(
      market.data.merchants[index].controller_account_id,
      `${id}-bazaar.testnet`,
    );
  }
  const marketSnapshot = {
    checked_at_utc: new Date().toISOString(),
    finalized_block: {
      hash: block_id,
      height: block.header.height,
      timestamp_ns: block.header.timestamp_nanosec,
    },
    contract_account: account,
    market,
    player: await view("get_player", { account_id: player }),
    trades: await view("get_recent_trades", {
      after_id: null,
      limit: "50",
      expected_revision: expectedRevision,
    }),
    offer: await view("get_offer", { offer_id: "1" }),
    keys: {},
  };
  for (const actor of Object.values(actors)) {
    const key = await query("view_access_key", actor.id, {
      public_key: actor.key,
    });
    if (actor.id === player) assert.equal(key.permission, "FullAccess");
    else {
      const permission = key.permission.FunctionCall;
      assert.equal(permission.receiver_id, contract);
      assert.deepEqual(
        [...permission.method_names].sort(),
        [...runtimeMethods].sort(),
      );
      assert.ok(
        BigInt(permission.allowance) > 0n &&
          BigInt(permission.allowance) <= 100000000000000000000000n,
      );
    }
    marketSnapshot.keys[actor.id] = key;
  }
  return marketSnapshot;
}
function getBalances(marketSnapshot) {
  const rows = [...marketSnapshot.market.data.merchants];
  if (marketSnapshot.player.data) rows.push(marketSnapshot.player.data);
  return rows.map((actor) => ({
    gold: actor.gold,
    inventory: actor.inventory,
  }));
}

function assertConservation(marketSnapshot, registered) {
  const market = marketSnapshot.market.data;
  const balances = getBalances(marketSnapshot);
  const issuedGold = registered ? 650n : 550n;
  assert.equal(market.registered_player_count, registered ? "1" : "0");
  assert.equal(
    balances.reduce((total, actor) => total + BigInt(actor.gold), 0n),
    issuedGold,
  );
  assert.equal(market.total_issued_gold, String(issuedGold));
  const supply = { crystal: 29n, wood: 25n, herb: 26n, iron: 24n };
  for (const resource of resources) {
    const total = balances.reduce(
      (sum, actor) => sum + BigInt(actor.inventory[resource]),
      0n,
    );
    assert.equal(total, supply[resource]);
    assert.equal(market.resource_supply[resource], String(supply[resource]));
  }
}

function assertTransfer(
  before,
  after,
  buyerIndex,
  sellerIndex,
  quantity,
  totalPrice,
) {
  const previousBalances = getBalances(before);
  const currentBalances = getBalances(after);
  assert.equal(previousBalances.length, currentBalances.length);
  for (const [index, previous] of previousBalances.entries()) {
    const current = currentBalances[index];
    let goldDelta = 0n;
    let crystalDelta = 0n;
    if (index === buyerIndex) {
      goldDelta = -totalPrice;
      crystalDelta = quantity;
    } else if (index === sellerIndex) {
      goldDelta = totalPrice;
      crystalDelta = -quantity;
    }
    assert.equal(BigInt(current.gold), BigInt(previous.gold) + goldDelta);
    for (const resource of resources) {
      const delta = resource === "crystal" ? crystalDelta : 0n;
      assert.equal(
        BigInt(current.inventory[resource]),
        BigInt(previous.inventory[resource]) + delta,
      );
    }
  }
}

function parseArguments() {
  const [mode, cliPath] = process.argv.slice(2);
  assert.ok(
    mode === "--verify" ||
      (["--execute", "--resume-after-purchase"].includes(mode) && cliPath),
    "Usage: node scripts/run-testnet-fixture.mjs --verify OR <--execute|--resume-after-purchase> <near-cli-executable>",
  );
  return { mode, cliPath };
}

async function verifySavedFixture() {
  const saved = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(saved.status, "verified_final_success");
  assert.deepEqual(
    saved.steps.map((step) => step.method),
    ["register_player", "buy_from_merchant", "propose_trade", "accept_trade"],
  );
  for (const [index, step] of saved.steps.entries()) {
    const actor =
      index < 2 ? actors.player : index === 2 ? actors.rex : actors.luna;
    const observed = await callRpc("tx", {
      tx_hash: step.transaction_hash,
      sender_account_id: actor.id,
      wait_until: "FINAL",
    });
    assert.deepEqual(observed, step.receipt);
    assert.equal(observed.transaction.public_key, actor.key);
    assertConservation(step.after, true);
  }
  const current = await readMarketSnapshot("5");
  assertConservation(saved.before, false);
  assertConservation(current, true);
  assertTransfer(
    saved.steps[0].after,
    saved.steps[1].after,
    actorIndex.player,
    actorIndex.rex,
    12n,
    48n,
  );
  assert.deepEqual(
    getBalances(saved.steps[1].after),
    getBalances(saved.steps[2].after),
  );
  assertTransfer(
    saved.steps[2].after,
    current,
    actorIndex.rex,
    actorIndex.luna,
    4n,
    24n,
  );
  assert.deepEqual(current.market.data, saved.steps[3].after.market.data);
  assert.deepEqual(current.player.data, saved.steps[3].after.player.data);
  assert.deepEqual(current.trades.data, saved.steps[3].after.trades.data);
  assert.deepEqual(current.offer.data, saved.steps[3].after.offer.data);
  console.log(
    JSON.stringify({
      verified: "P2.21",
      mode: "read_only",
      block: current.finalized_block,
      final_receipts: 4,
      gold: "650",
      crystals: "29",
    }),
  );
}

async function prepareRun(resume, cliPath) {
  const previous = resume
    ? JSON.parse(await readFile(evidencePath, "utf8"))
    : null;
  const before = resume ? previous.before : await readMarketSnapshot("1");
  assertConservation(before, false);
  assert.equal(before.player.data, null);
  assert.equal(before.market.data.next_offer_id, "1");
  assert.equal(before.market.data.next_trade_id, "1");
  assert.deepEqual(before.trades.data.items, []);
  for (const merchant of before.market.data.merchants)
    assert.equal(merchant.last_action_id, "0");
  // Exclusive creation protects an existing run/journal from an accidental replay.
  if (!resume) {
    await mkdir(privateDir);
    await writeJson(evidencePath, { status: "preparing" }, true);
  }
  const evidence = previous ?? {
    network: "testnet",
    rpc_url: rpcUrl,
    contract_account_id: contract,
    source_commit: "89b227bb5a1c2e06e6d84bef4bd0d6f1d7e2d223",
    code_hash: codeHash,
    mode: "manual_contract_fixture_no_ai",
    before,
    steps: [],
  };
  const journal = resume
    ? JSON.parse(await readFile(join(privateDir, "journal.json"), "utf8"))
    : {
        created_at_utc: new Date().toISOString(),
        network: "testnet",
        steps: [],
      };

  async function persist() {
    await writeJson(join(privateDir, "journal.json"), journal);
    await writeJson(evidencePath, evidence);
  }

  const run = { evidence, journal, persist, cliPath };
  if (resume) await recoverUnsubmittedProposal(run);
  await persist();
  return run;
}

async function recoverUnsubmittedProposal(run) {
  const { evidence, journal } = run;
  // This recovery path is limited to the known CLI signer-selection failure
  // before any proposal broadcast. It cannot replace an unknown transaction.
  assert.deepEqual(
    evidence.steps.map((s) => s.label),
    ["registration", "purchase"],
  );
  assert.equal(journal.steps.length, 3);
  const stopped = journal.steps[2];
  assert.equal(stopped.label, "proposal");
  assert.equal(stopped.state, "intent_persisted");
  assert.equal(stopped.transaction_hash, undefined);
  for (const step of evidence.steps) {
    const original = await callRpc("tx", {
      tx_hash: step.transaction_hash,
      sender_account_id: player,
      wait_until: "FINAL",
    });
    assert.deepEqual(original, step.receipt);
  }
  const current = await readMarketSnapshot("3");
  assert.deepEqual(current.market.data, evidence.steps[1].after.market.data);
  assert.deepEqual(current.player.data, evidence.steps[1].after.player.data);
  const path = join(privateDir, "proposal.signed.json");
  const signedBytes = await readFile(path);
  const wrong = SignedTransaction.decode(
    Buffer.from(JSON.parse(signedBytes).signed_transaction_as_base64, "base64"),
  ).transaction;
  assert.equal(wrong.signerId, actors.rex.id);
  assert.equal(
    wrong.publicKey.toString(),
    "ed25519:DYeowm8e4t2ca9xWsipJdwDnZC7fTgVmMfxaJGbC2zLK",
  );
  const full = await callRpc("query", {
    request_type: "view_access_key",
    account_id: actors.rex.id,
    public_key: wrong.publicKey.toString(),
    block_id: current.finalized_block.hash,
  });
  assert.equal(wrong.nonce, BigInt(full.nonce) + 1n);
  await rename(
    path,
    join(privateDir, "proposal-abandoned-recovery-key.signed.json"),
  );
  await rename(
    join(privateDir, "proposal.args.json"),
    join(privateDir, "proposal-abandoned-recovery-key.args.json"),
  );
  journal.quarantined = [
    {
      ...stopped,
      state: "not_broadcast_signer_mismatch",
      transaction_hash: baseEncode(
        createHash("sha256").update(wrong.encode()).digest(),
      ),
      signed_file_sha256: sha256(signedBytes),
      signed_file: "proposal-abandoned-recovery-key.signed.json",
    },
  ];
  journal.steps.pop();
  evidence.signing_note =
    "The online CLI selected Rex's recovery key despite the public-key option. The decoded-key guard rejected it before broadcast. The unsubmitted file was quarantined; subsequent signing uses offline keychain selection with verified nonce/block/public-key inputs.";
}

async function signCall({
  cliPath,
  argsPath,
  signedPath,
  actor,
  method,
  args,
  fresh,
  label,
}) {
  const signedResult = spawnSync(
    cliPath,
    [
      "--offline",
      "contract",
      "call-function",
      "as-transaction",
      contract,
      method,
      "file-args",
      argsPath,
      "prepaid-gas",
      "30 Tgas",
      "attached-deposit",
      "0 NEAR",
      "sign-as",
      actor.id,
      "network-config",
      "testnet",
      "sign-with-keychain",
      "--signer-public-key",
      actor.key,
      "--nonce",
      (BigInt(fresh.keys[actor.id].nonce) + 1n).toString(),
      "--block-hash",
      fresh.finalized_block.hash,
      "--block-height",
      String(fresh.finalized_block.height),
      "save-to-file",
      signedPath,
    ],
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  // CLI output may include the signature; never project it into public evidence.
  assert.equal(
    signedResult.status,
    0,
    `${label}: signing failed; inspect local keychain, never fall back to recovery credentials`,
  );
  const bytes = await readFile(signedPath);
  const saved = JSON.parse(bytes);
  const tx = SignedTransaction.decode(
    Buffer.from(saved.signed_transaction_as_base64, "base64"),
  ).transaction;
  assert.equal(tx.signerId, actor.id);
  assert.equal(tx.receiverId, contract);
  assert.equal(tx.publicKey.toString(), actor.key);
  assert.equal(tx.nonce, BigInt(fresh.keys[actor.id].nonce) + 1n);
  assert.equal(tx.actions.length, 1);
  const call = tx.actions[0].functionCall;
  assert.equal(call.methodName, method);
  assert.equal(call.deposit, 0n);
  assert.equal(call.gas, 30000000000000n);
  assert.deepEqual(JSON.parse(Buffer.from(call.args).toString("utf8")), args);
  return { bytes, saved, transaction: tx };
}

function verifyCallReceipt({
  sent,
  receipt,
  transactionHash,
  actor,
  method,
  args,
  revision,
}) {
  assert.equal(sent.transaction.hash, transactionHash);
  assert.equal(receipt.final_execution_status, "FINAL");
  assert.equal(receipt.transaction.hash, transactionHash);
  assert.equal(receipt.transaction.signer_id, actor.id);
  assert.equal(receipt.transaction.receiver_id, contract);
  assert.equal(receipt.transaction.public_key, actor.key);
  assert.ok(Object.hasOwn(receipt.status, "SuccessValue"));
  assert.equal(receipt.transaction.actions.length, 1);
  const action = receipt.transaction.actions[0].FunctionCall;
  assert.equal(action.method_name, method);
  assert.equal(action.deposit, "0");
  assert.equal(action.gas, 30000000000000);
  assert.deepEqual(
    JSON.parse(Buffer.from(action.args, "base64").toString("utf8")),
    args,
  );
  for (const outcome of [
    receipt.transaction_outcome,
    ...receipt.receipts_outcome,
  ])
    assert.ok(!Object.hasOwn(outcome.outcome.status, "Failure"));
  const result = JSON.parse(
    Buffer.from(receipt.status.SuccessValue, "base64").toString("utf8"),
  );
  assert.equal(result.market_revision, revision);
  const events = receipt.receipts_outcome
    .filter((r) => r.outcome.executor_id === contract)
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice(11)));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    standard: "bot_bazaar",
    version: "1.0.0",
    event: method,
    data: [
      {
        initiator_account_id: actor.id,
        market_revision: revision,
        block_height: result.block_height,
        block_timestamp_ns: result.block_timestamp_ns,
        result: result.data,
      },
    ],
  });
  return result;
}

async function executeCall(run, label, actor, method, args, revision, current) {
  const { evidence, journal, persist, cliPath } = run;
  // Verify current code/controller/key authority immediately before new signing.
  const fresh = await readMarketSnapshot(current.market.market_revision);
  assert.deepEqual(fresh.market.data, current.market.data);
  assert.deepEqual(fresh.player.data, current.player.data);
  const argsPath = join(privateDir, `${label}.args.json`),
    signedPath = join(privateDir, `${label}.signed.json`);
  await writeJson(argsPath, args, true);
  const intent = {
    label,
    caller: actor.id,
    public_key: actor.key,
    method,
    args,
    state: "intent_persisted",
  };
  journal.steps.push(intent);
  await persist();
  const { bytes, saved, transaction } = await signCall({
    cliPath,
    argsPath,
    signedPath,
    actor,
    method,
    args,
    fresh,
    label,
  });
  intent.transaction_hash = baseEncode(
    createHash("sha256").update(transaction.encode()).digest(),
  );
  intent.signed_file = join("target/phase-02-fixture", `${label}.signed.json`);
  intent.signed_file_sha256 = sha256(bytes);
  intent.state = "signed_persisted";
  await persist();
  intent.state = "broadcasting";
  await persist();
  const sent = await callRpc("send_tx", {
    signed_tx_base64: saved.signed_transaction_as_base64,
    wait_until: "FINAL",
  });
  // Fetch independently by the original transaction hash; never infer finality
  // from logs, a returned submission hash, or unchanged balances.
  const receipt = await callRpc("tx", {
    tx_hash: intent.transaction_hash,
    sender_account_id: actor.id,
    wait_until: "FINAL",
  });
  const result = verifyCallReceipt({
    sent,
    receipt,
    transactionHash: intent.transaction_hash,
    actor,
    method,
    args,
    revision,
  });
  intent.state = "confirmed_final_success";
  intent.confirmed_at_utc = new Date().toISOString();
  const step = {
    label,
    caller: actor.id,
    signer_public_key: actor.key,
    method,
    args,
    transaction_hash: intent.transaction_hash,
    explorer_url: `https://testnet.nearblocks.io/txns/${intent.transaction_hash}`,
    receipt,
    result,
  };
  evidence.steps.push(step);
  await persist();
  step.after = await readMarketSnapshot(revision);
  assertConservation(step.after, true);
  await persist();
  console.log(
    JSON.stringify({
      step: label,
      hash: intent.transaction_hash,
      status: "FINAL",
      revision,
    }),
  );
  return step.after;
}

async function runFixture(run, resume) {
  const { evidence, persist } = run;
  const before = evidence.before;
  const registered = resume
    ? evidence.steps[0].after
    : await executeCall(
        run,
        "registration",
        actors.player,
        "register_player",
        {},
        "2",
        before,
      );
  assert.equal(registered.player.data.gold, "100");
  assert.deepEqual(registered.player.data.inventory, {
    crystal: "0",
    wood: "0",
    herb: "0",
    iron: "0",
  });
  assert.deepEqual(
    registered.market.data.merchants,
    before.market.data.merchants,
  );
  const bought = resume
    ? evidence.steps[1].after
    : await executeCall(
        run,
        "purchase",
        actors.player,
        "buy_from_merchant",
        {
          merchant_id: "rex",
          resource: "crystal",
          quantity: "12",
          max_total_price: "48",
          listing_version: "1",
        },
        "3",
        registered,
      );
  assertTransfer(
    registered,
    bought,
    actorIndex.player,
    actorIndex.rex,
    12n,
    48n,
  );
  const proposalClock = await readMarketSnapshot("3");
  const expires = (
    BigInt(proposalClock.market.block_timestamp_ns) + 500000000000n
  ).toString();
  const proposed = await executeCall(
    run,
    "proposal",
    actors.rex,
    "propose_trade",
    {
      proposer: "rex",
      buyer: "rex",
      seller: "luna",
      resource: "crystal",
      quantity: "4",
      total_price: "24",
      expires_at_ns: expires,
      action_id: "1",
    },
    "4",
    bought,
  );
  assert.deepEqual(getBalances(proposed), getBalances(bought));
  assert.equal(proposed.offer.data.offer.offer_id, "1");
  assert.equal(proposed.offer.data.offer.status, "pending");
  const accepted = await executeCall(
    run,
    "acceptance",
    actors.luna,
    "accept_trade",
    { offer_id: "1", action_id: "1" },
    "5",
    proposed,
  );
  assertTransfer(proposed, accepted, actorIndex.rex, actorIndex.luna, 4n, 24n);
  assert.equal(accepted.offer.data.offer.status, "accepted");
  assert.equal(accepted.offer.data.offer.settled_trade_id, "2");
  assert.equal(accepted.market.data.next_offer_id, "2");
  assert.equal(accepted.market.data.next_trade_id, "3");
  assert.equal(accepted.trades.data.items.length, 2);
  assert.deepEqual(accepted.player.data, bought.player.data);
  assert.deepEqual(
    accepted.market.data.merchants[2],
    before.market.data.merchants[2],
  );
  for (const [index, gold, crystals, action] of [
    [0, "204", "7", "1"],
    [1, "244", "8", "1"],
    [2, "150", "2", "0"],
  ]) {
    const m = accepted.market.data.merchants[index];
    assert.equal(m.gold, gold);
    assert.equal(m.inventory.crystal, crystals);
    assert.equal(m.last_action_id, action);
  }
  assert.equal(accepted.player.data.gold, "52");
  assert.equal(accepted.player.data.inventory.crystal, "12");
  assert.deepEqual(
    accepted.trades.data.items[0],
    evidence.steps[1].result.data,
  );
  assert.deepEqual(
    accepted.trades.data.items[1],
    evidence.steps[3].result.data.trade,
  );
  assert.deepEqual(
    accepted.offer.data.offer,
    evidence.steps[3].result.data.offer,
  );
  assert.deepEqual(
    accepted.market.data.merchants[0].last_action,
    evidence.steps[2].result.data.action,
  );
  assert.deepEqual(
    accepted.market.data.merchants[1].last_action,
    evidence.steps[3].result.data.action,
  );
  for (const step of [evidence.steps[2], evidence.steps[3]]) {
    const canonical = JSON.stringify({
      args: Object.fromEntries(
        Object.keys(step.args)
          .sort()
          .map((key) => [key, step.args[key]]),
      ),
      method: step.method,
    });
    assert.equal(
      step.result.data.action.args_sha256,
      sha256(Buffer.from(canonical)),
    );
  }
  evidence.status = "verified_final_success";
  evidence.completed_at_utc = new Date().toISOString();
  evidence.conservation = {
    seed_gold: "550",
    registration_issuance: "100",
    total_gold: "650",
    resource_totals: { crystal: "29", wood: "25", herb: "26", iron: "24" },
  };
  await persist();
  console.log(
    JSON.stringify({
      verified: "P2.21",
      evidence: evidencePath,
      conservation: evidence.conservation,
    }),
  );
}

async function main() {
  const { mode, cliPath } = parseArguments();
  if (mode === "--verify") {
    await verifySavedFixture();
    return;
  }
  const resume = mode === "--resume-after-purchase";
  const run = await prepareRun(resume, cliPath);
  await runFixture(run, resume);
}

await main();
