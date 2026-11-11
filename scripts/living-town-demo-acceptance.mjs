// Finite owner-invoked acceptance. No web/reader server and no detached runtime.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkDemoAdmission, demoLifecycle, withDemoLifecycle } from "./living-town-demo-lifecycle.mjs";
import {
  LivingTownClient,
  createRpcTransport,
  createLivingTownCall,
  playerReceiptProof,
} from "../packages/chain/dist/index.js";
import { RuntimeBudget } from "../apps/worker/dist/private/living-town/runtime-budget.js";
import {
  nearAiCredential,
  nearAiPreflight,
  nearAiModel,
} from "../apps/worker/dist/private/living-town/near-ai-cloud.js";
import {
  load,
  save,
  demoLimits,
  demoRpc,
  result,
  sendDemoTransaction,
  archiveTransaction,
  near,
  root,
  sha,
} from "./living-town-demo-deployment.mjs";

export const callReserveMicro =
  Math.ceil(((65536 + 256) * 300000) / 1000000) +
  Math.ceil((512 * 1200000) / 1000000);
export function mayContinue(limits, elapsed, calls, spent) {
  return (
    elapsed < limits.duration_ms - 45000 &&
    calls < limits.max_provider_calls &&
    spent + callReserveMicro <= limits.max_inference_micro
  );
}
export function requiredPlayerSetup(player) {
  return {
    register: player === null,
    shop: player === null || player.shop_id === null,
  };
}
export function genuineSettlement(audit) {
  return audit.roots.find((r) => {
    // This is a candidate, not chain confirmation. Recovery may confirm the
    // acceptance before reaction scheduling copies its trade ID into the root.
    if (!r.offer_id) return false;
    const turns = ["buyer", "seller"].map((role) =>
      audit.steps.find(
        (s) =>
          s.root_id === r.id &&
          s.role === role &&
          s.decision?.origin === "model_proposal" &&
          s.decision.proposal?.action.type ===
            (role === "buyer" ? "propose_trade" : "accept_trade") &&
          audit.providers.some(
            (p) =>
              p.id === s.decision.inferenceRef &&
              p.merchant === s.merchant &&
              p.status === "accepted",
          ),
      ),
    );
    return (
      turns.every(Boolean) &&
      turns[0].merchant !== turns[1].merchant &&
      turns[0].decision.inferenceRef !== turns[1].decision.inferenceRef
    );
  });
}
export function pendingFollowups(audit) {
  return audit.roots.filter(r => r.state !== "closed").map(r => ({
    root_id: r.id,
    state: r.state,
    pending_steps: audit.steps.filter(s => s.root_id === r.id && s.state !== "completed")
      .map(s => ({ id: s.id, merchant: s.merchant, role: s.role, state: s.state })),
    remaining_followup_merchants: ["rex", "luna", "bolt"].filter(merchant =>
      !audit.steps.some(s => s.root_id === r.id && s.role === "followup" &&
        s.merchant === merchant && s.state === "completed")),
  }));
}
export async function recordGenuineSettlement(plan, client, audit) {
  // Examine every independent candidate so an old, unaccepted offer cannot
  // hide a later settlement. Read offer and trade at the same finalized block.
  const candidates = audit.roots.filter(r => genuineSettlement({ ...audit, roots: [r] }));
  if (!candidates.length) return null;
  const pinned = await client.finalized();
  for (const candidate of candidates) {
    const offer = await pinned.getOffer(candidate.offer_id);
    if (offer.data.kind !== "found" || offer.data.offer.status !== "accepted") continue;
    const accepted = offer.data.offer;
    assert(accepted.trade_id, "Accepted offer must identify its trade");
    if (candidate.trade_id) assert.equal(accepted.trade_id, candidate.trade_id);
    const trade = await pinned.getTrade(accepted.trade_id);
    assert.equal(trade.data.kind, "found");
    const settled = trade.data.value;
    assert.equal(accepted.offer_id, candidate.offer_id);
    assert.equal(settled.offer_id, accepted.offer_id);
    assert.equal(settled.trade_id, accepted.trade_id);
    assert.equal(settled.buyer.kind, "merchant");
    assert.equal(settled.seller.kind, "merchant");
    assert.equal(settled.buyer.merchant_id, accepted.buyer);
    assert.equal(settled.seller.merchant_id, accepted.seller);
    for (const key of ["item_id", "quantity", "unit_price", "total_price"])
      assert.equal(settled[key], accepted[key], `Finalized trade ${key} mismatch`);
    assert.equal(settled.settled_at_ns, accepted.closed_at_ns);
    assert.equal(settled.command_principal, accepted.closing_principal);
    assert.equal(settled.command_sequence, accepted.closing_command_sequence);
    const turns = ["buyer", "seller"].map(role => audit.steps.find(s =>
      s.root_id === candidate.id && s.role === role && s.decision?.origin === "model_proposal" &&
      s.decision.proposal?.action.type === (role === "buyer" ? "propose_trade" : "accept_trade") &&
      audit.providers.some(p => p.id === s.decision.inferenceRef && p.merchant === s.merchant && p.status === "accepted")));
    const [buyer, seller] = turns;
    assert.equal(buyer.merchant, accepted.buyer);
    assert.equal(seller.merchant, accepted.seller);
    const proposal = buyer.decision.proposal.action;
    assert.equal(proposal.side, "buy");
    assert.equal(proposal.counterparty, accepted.seller);
    for (const key of ["item_id", "quantity", "unit_price"])
      assert.equal(proposal[key], accepted[key], `Model-selected ${key} mismatch`);
    assert.equal(seller.decision.proposal.action.offer_id, accepted.offer_id);
    const settlement = { ...candidate, trade_id: accepted.trade_id };
    await save(join(plan.public_dir, "settlement-proof.json"), {
      block: pinned.block, offer, trade, root_id: candidate.id,
      independent_model_turns: turns,
      reaction_root_state: candidate.state,
      reaction_root_close_reason: candidate.close_reason,
      pending_followups: pendingFollowups({ ...audit, roots: [candidate] }),
      note: "Finalized settlement is independent of optional reaction follow-up completion.",
    });
    return settlement;
  }
  return null;
}
export function acceptanceCutoff(limits, elapsed, calls, spent, budgetBlocked) {
  if (calls >= limits.max_provider_calls) return "provider_call_limit";
  if (spent + callReserveMicro > limits.max_inference_micro) return "inference_allowance_limit";
  if (budgetBlocked) return "shared_budget_blocked";
  if (!mayContinue(limits, elapsed, calls, spent)) return "admission_time_limit";
  return null;
}
async function acceptanceRuntimePoll(plan, config, limits, started, recoveryOnly) {
  if (demoLifecycle()?.stopped) throw Object.assign(new Error("DEMO_INTERRUPTED"), { code: "DEMO_INTERRUPTED" });
  const remaining = limits.duration_ms - (Date.now() - started);
  // Preserve the existing final 45 seconds for reconciliation. Recovery never
  // enters the active scheduler or admits another provider turn/game action.
  const timeout = Math.min(90000, remaining - (recoveryOnly ? 0 : 45000));
  if (timeout <= 0) return false;
  await setDemoControl(config, recoveryOnly ? "recovery_only" : "active");
  try { await runtimeOnce(plan, [], timeout); return true; }
  catch {
    if (demoLifecycle()?.stopped) throw Object.assign(new Error("DEMO_INTERRUPTED"), { code: "DEMO_INTERRUPTED" });
    if (demoLifecycle()?.childCleanupFailed) throw Object.assign(new Error("DEMO_CHILD_NOT_STOPPED"), { code: "DEMO_CHILD_NOT_STOPPED" });
    // A child exit/timeout does not resolve the original intent. Fence further
    // admission and let subsequent recovery-only polls inspect its journal.
    return false;
  }
  finally { await setDemoControl(config, "paused"); }
}
export async function setDemoControl(config, mode) {
  assert(["paused", "active", "recovery_only"].includes(mode));
  if (demoLifecycle()) return demoLifecycle().control(mode);
  const { atomicRuntimeJson } =
    await import("../apps/worker/dist/private/living-town/runtime-outbox.js");
  await atomicRuntimeJson(config.control_file, {
    schema: "living-town-runtime-control-v1",
    mode,
  });
}
export function readDemoAudit(config) {
  const db = new DatabaseSync(join(config.execution_dir, "worker.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      roots: db.prepare("SELECT * FROM reaction_roots ORDER BY rowid").all(),
      steps: db
        .prepare(
          "SELECT id,root_id,merchant,role,state,decision_json FROM reaction_steps ORDER BY rowid",
        )
        .all()
        .map(({ decision_json, ...r }) => ({
          ...r,
          decision: decision_json ? JSON.parse(decision_json) : null,
        })),
      providers: db
        .prepare(
          "SELECT id,tick_id,merchant,provider,model,prompt_version,status,payload_hash,code,proposal_json,started_at,dispatched_at,finished_at FROM town_provider_attempts ORDER BY rowid",
        )
        .all()
        .map(({ proposal_json, ...r }) => ({
          ...r,
          proposal: proposal_json ? JSON.parse(proposal_json) : null,
        })),
      unresolved: db
        .prepare(
          "SELECT id,method,status,merchant_id FROM intents WHERE status IN ('prepared','signed','submitted','unknown')",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}
export function sharedBudgetSnapshot(config, ids = []) {
  const budget = new RuntimeBudget(
    config.provider.budget_dir,
    config.provider.budget_witness_dir,
  );
  try {
    const status = budget.budget.status();
    return {
      binding: budget.binding,
      status,
      remaining_project_micro: Math.max(
        0,
        (status.totalLimit ?? 10000000) -
          (status.totalMicro ?? status.monthlyMicro),
      ),
      receipts: ids.map((id) => ({
        request_id: id,
        receipt: budget.receipt(id),
      })),
    };
  } finally {
    budget.close();
  }
}
export async function runtimeOnce(plan, flags = [], timeoutMs = 90000) {
  const lifecycle = demoLifecycle();
  if (!lifecycle || lifecycle.childCleanupFailed || lifecycle.child)
    throw Object.assign(new Error("DEMO_CHILD_SCOPE_UNAVAILABLE"), { code: "DEMO_CHILD_SCOPE_UNAVAILABLE" });
  const output = await open(join(plan.directory, "runtime.stdout.log"), "a");
  let errors;
  try {
    errors = await open(join(plan.directory, "runtime.stderr.log"), "a");
    if (lifecycle?.stopped) throw Object.assign(new Error("DEMO_INTERRUPTED"), { code: "DEMO_INTERRUPTED" });
    await new Promise((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          join(root, "apps/worker/dist/living-town-runtime.js"),
          "--config",
          join(plan.directory, "runtime.json"),
          "--once",
          ...flags,
        ],
        {
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", output.fd, errors.fd],
        },
      );
      let timedOut = false, spawnError = null, attachError = null;
      const onAbort = () => {
        void lifecycle.stopChild().then(() => {
          if (lifecycle.childCleanupFailed) {
            clearTimeout(timer);
            lifecycle.controller.signal.removeEventListener("abort", onAbort);
            child.unref();
            reject(Object.assign(new Error("DEMO_CHILD_NOT_STOPPED"), { code: "DEMO_CHILD_NOT_STOPPED" }));
          }
        }).catch(reject);
      };
      lifecycle.controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, timeoutMs);
      child.once("error", (error) => { spawnError = error; });
      // 'close' waits for process exit and inherited stdout/stderr closure.
      child.once("close", (code) => {
        clearTimeout(timer);
        lifecycle.controller.signal.removeEventListener("abort", onAbort);
        lifecycle?.detach(child);
        code === 0 && !timedOut && !lifecycle?.stopped && !attachError && !spawnError
          ? done()
          : reject(
              spawnError ?? attachError ?? Error(
                "Bounded runtime exited; inspect retained status/logs and reconcile original work",
              ),
            );
      });
      void lifecycle.attach(child).catch(async error => {
        attachError = error;
        await lifecycle.stopChild();
        if (lifecycle.childCleanupFailed) {
          clearTimeout(timer);
          lifecycle.controller.signal.removeEventListener("abort", onAbort);
          child.unref(); reject(error);
        }
      }).catch(reject);
    });
  } finally {
    await output.close();
    await errors?.close();
  }
}
async function chainSnapshot(client, player) {
  const reader = await client.finalized(),
    town = await reader.getTown();
  return { block: reader.block, town, player: await reader.getPlayer(player) };
}
async function playerAction(plan, config, method, input, label, description) {
  checkDemoAdmission();
  const client = new LivingTownClient(
    config.identity,
    createRpcTransport(plan.rpc_url),
  );
  const reader = await client.finalized(),
    town = await reader.getTown();
  const key = await load(join(plan.private_dir, "player.json"));
  const command = await reader.getCommand(
    key.account_id,
    "18446744073709551615",
  );
  const call = createLivingTownCall(method, {
    ...input,
    command: {
      sequence: command.data.next_sequence,
      config_version: "1",
      valid_until_ns: (
        BigInt(town.block_timestamp_ns) + 60000000000n
      ).toString(),
    },
  });
  const before = await chainSnapshot(client, key.account_id);
  checkDemoAdmission();
  // Persist the action label and original request before entering signing. If
  // the process dies between saving signed bytes and recording their hash,
  // recovery can inspect that exact intent file without inventing a new action.
  await demoLifecycle()?.playerIntent({ label, status: "unresolved", signer_id: key.account_id,
    receiver_id: config.public.contractId, proof: { signerId: key.account_id,
      deployment: config.identity.deployment, call, referenceBlockHeight: reader.block.height } });
  const receipt = await sendDemoTransaction(
    plan,
    label,
    key,
    config.public.contractId,
    [near.actions.functionCall(method, call.args, 30000000000000n, 0n)],
    description,
    {
      admit: checkDemoAdmission,
      onIntent: record => demoLifecycle()?.playerIntent({ ...record, proof: {
        transactionHash: record.transaction_hash, signerId: key.account_id,
        deployment: config.identity.deployment, call, referenceBlockHeight: reader.block.height,
      } }),
    },
  );
  const after = await chainSnapshot(client, key.account_id);
  await archiveTransaction(plan, receipt, description, {
    method,
    args: call.args,
    before,
    after,
  });
  // Publish public receipt discovery data alongside runtime proofs. The reader
  // still fetches and verifies the original transaction; no signed bytes leave.
  const { atomicRuntimeJson } =
    await import("../apps/worker/dist/private/living-town/runtime-outbox.js");
  await atomicRuntimeJson(
    join(config.receipt_outbox, `${receipt.transaction.hash}.json`),
    {
      schema: "living-town-receipt-inbox-v1",
      requests: [
        {
          transaction_hash: receipt.transaction.hash,
          signer_id: key.account_id,
          method,
          args: call.args,
          reference_block_height: reader.block.height,
        },
      ],
    },
  );
  return receipt;
}
async function purchase(
  plan,
  config,
  opportunity,
  quantity = "8",
  label = null,
) {
  checkDemoAdmission();
  const client = new LivingTownClient(
      config.identity,
      createRpcTransport(plan.rpc_url),
    ),
    reader = await client.finalized(),
    town = await reader.getTown();
  const merchant = opportunity === 0 ? "rex" : "bolt",
    item = opportunity === 0 ? "crystal" : "wood";
  const listings = await reader.getListings({
    shop_id: merchant === "rex" ? "1" : "3",
    item_id: item,
    active_only: true,
    after_id: null,
    limit: "50",
    expected_market_revision: town.market_revision,
  });
  const listing = listings.data.items[0];
  assert(
    listing && BigInt(listing.remaining_quantity) >= BigInt(quantity),
    "Real retail stock is required; do not fabricate demand",
  );
  return playerAction(
    plan,
    config,
    "buy_from_merchant",
    {
      merchant_id: merchant,
      item_id: item,
      quantity,
      expected_listing_revision: listing.revision,
      max_total_price: (
        BigInt(listing.unit_price) * BigInt(quantity)
      ).toString(),
    },
    label ?? `purchase-${opportunity + 1}`,
    `Real player buys ${quantity} ${item} from ${merchant}; allow independent merchant reactions`,
  );
}
async function archiveRuntimeTransactions(plan, config, before, after) {
  const rpc = demoRpc(plan);
  const descriptions = {
    propose_trade:
      "Buyer proposes immutable trade terms; only buyer gold/capacity are reserved",
    accept_trade:
      "Independent seller accepts; goods and game gold settle atomically",
    reject_trade: "Seller declines; release buyer promises without a transfer",
    cancel_trade: "Buyer cancels; release promises without a transfer",
    expire_offers: "Finalize overdue offer cleanup; release remaining promises",
    set_listing:
      "Update retail listing reservations; this alone is not a merchant exchange",
    start_production: "Reserve and consume recipe ingredients for production",
    complete_production: "Complete a ready production job",
    allocate_raw_supply:
      "Allocate bounded source goods; this is not merchant trading",
    sweep_merchant_treasury: "Sweep bounded excess merchant treasury",
    fund_customer_budget: "Top up town customer game-gold budget",
    settle_customer_purchase: "Town customer purchases a player product",
  };
  const known = new Set(
    (await load(join(plan.public_dir, "transactions.json"))).map(
      (r) => r.transaction_hash,
    ),
  );
  for (const filename of await readdir(config.receipt_outbox)) {
    if (
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(filename) ||
      known.has(filename.slice(0, -5))
    )
      continue;
    const inbox = await load(join(config.receipt_outbox, filename));
    for (const proof of inbox.requests) {
      const receipt = await result(rpc, "tx", {
        tx_hash: proof.transaction_hash,
        sender_account_id: proof.signer_id,
        wait_until: "FINAL",
      });
      await archiveTransaction(
        plan,
        receipt,
        descriptions[proof.method] ?? proof.method,
        {
          method: proof.method,
          args: proof.args,
          reference_block_height: proof.reference_block_height,
          before,
          after,
          snapshot_scope:
            "Finalized snapshots bracketing one runtime poll; exact per-action ledgers are in receipt outcome",
        },
      );
    }
  }
}
async function managedDemo(plan, operation, options) {
  const config = await load(join(plan.directory, "runtime.json"));
  return withDemoLifecycle(plan, config, () => operation(plan), () => readDemoAudit(config), options);
}
export const initializeDemoRuntime = plan => managedDemo(plan, initializeDemoRuntimeWork);
export const runDemoAcceptance = plan => managedDemo(plan, runDemoAcceptanceWork);
export const runDemoContinuation = plan => managedDemo(plan, runDemoContinuationWork);
export const recoverDemoHelper = plan => managedDemo(plan, recoverDemoHelperWork, { recover: true });

async function initializeDemoRuntimeWork(plan) {
  const config = await load(join(plan.directory, "runtime.json"));
  assert.equal((await load(config.control_file)).mode, "paused");
  const previous = await load(
    join(root, "data/living-town-runtime.ai.local.json"),
  );
  assert.equal(
    (await load(previous.control_file)).mode,
    "paused",
    "Prior runtime must remain paused; shared budget cannot have concurrent owners",
  );
  const quote = await nearAiPreflight(
    nearAiCredential(config.provider.key_file),
  );
  await save(join(plan.public_dir, "provider-preflight.json"), {
    ...quote,
    paid_calls: 0,
  });
  await save(
    join(plan.public_dir, "budget-before.json"),
    sharedBudgetSnapshot(config),
  );
  await runtimeOnce(plan, ["--check"]);
  await runtimeOnce(plan, ["--initialize", "--enable-provider"]);
  assert.equal((await load(config.control_file)).mode, "paused");
  await save(join(plan.public_dir, "runtime-preflight.json"), {
    captured_at: new Date().toISOString(),
    mode: "paused",
    shared_budget_reused: true,
    model: nearAiModel,
    status: await load(join(config.execution_dir, "runtime-status.json")),
    audit: readDemoAudit(config),
  });
}
async function runDemoAcceptanceWork(plan) {
  const config = await load(join(plan.directory, "runtime.json"));
  const limits = demoLimits(plan.limits);
  assert.equal((await load(config.control_file)).mode, "paused");
  const baseline = sharedBudgetSnapshot(config);
  assert(!baseline.status.blocked);
  assert(
    baseline.remaining_project_micro >= limits.max_inference_micro,
    "Not enough remaining project allowance for the reviewed test envelope",
  );
  const old = await load(join(root, "data/living-town-runtime.ai.local.json"));
  assert.equal((await load(old.control_file)).mode, "paused");
  const initialAudit = readDemoAudit(config);
  assert.equal(
    initialAudit.providers.length,
    0,
    "Use a new reviewed acceptance directory; never reset prior AI accounting",
  );
  try {
    const previousResult = await load(
      join(plan.public_dir, "acceptance-result.json"),
    );
    assert.equal(
      previousResult.opportunities,
      0,
      "Resume purchased work through original journals, not a new acceptance run",
    );
    assert.equal(
      previousResult.audit.providers.length,
      0,
      "Never reset a paid acceptance envelope",
    );
    await save(
      join(plan.public_dir, "acceptance-before-storage-correction.json"),
      previousResult,
      true,
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await save(join(plan.public_dir, "acceptance-start.json"), {
    started_at: new Date().toISOString(),
    limits,
    budget: baseline,
    model: nearAiModel,
    one_call_max_micro: callReserveMicro,
    helper_sha256: sha(await readFile(new URL(import.meta.url))),
  });
  const started = Date.now(),
    client = new LivingTownClient(
      config.identity,
      createRpcTransport(plan.rpc_url),
    ),
    player = plan.roles.player.account_id;
  let audit = initialAudit,
    opportunities = 0,
    reason = "bounded_limit",
    success = null,
    budget = baseline,
    admissionStopped = null,
    limitsExceeded = false;
  try {
    const existingPlayer = (await (await client.finalized()).getPlayer(player))
      .data;
    const setup = requiredPlayerSetup(existingPlayer);
    if (setup.register)
      await playerAction(
        plan,
        config,
        "register_player",
        {},
        "register-player",
        "Register the dedicated Testnet player and grant starter game gold once",
      );
    if (setup.shop)
      await playerAction(
        plan,
        config,
        "create_shop",
        { name: "Demo Player" },
        "create-shop",
        "Create the dedicated player shop required for inventory and purchases",
      );
    admissionStopped = acceptanceCutoff(limits, Date.now() - started, audit.providers.length,
      (budget.status.totalMicro ?? budget.status.monthlyMicro) -
        (baseline.status.totalMicro ?? baseline.status.monthlyMicro), budget.status.blocked);
    if (!admissionStopped) await purchase(plan, config, opportunities++);
    while (!demoLifecycle()?.stopped && Date.now() - started < limits.duration_ms) {
      admissionStopped ??= acceptanceCutoff(
        limits, Date.now() - started, audit.providers.length,
        (budget.status.totalMicro ?? budget.status.monthlyMicro) -
          (baseline.status.totalMicro ?? baseline.status.monthlyMicro), budget.status.blocked);
      const existingSettlement = await recordGenuineSettlement(plan, client, audit);
      if (existingSettlement) {
        success = existingSettlement;
        reason = "genuine_independent_settlement";
        if (audit.unresolved.length === 0) break;
        admissionStopped ??= "settlement_confirmed_recovering_original_intents";
      }
      if (admissionStopped && audit.unresolved.length === 0) {
        reason = admissionStopped;
        break;
      }
      const before = await chainSnapshot(client, player);
      if (!await acceptanceRuntimePoll(plan, config, limits, started, !!admissionStopped))
        admissionStopped ??= "runtime_poll_failed_recovery_only";
      const after = await chainSnapshot(client, player);
      await archiveRuntimeTransactions(plan, config, before, after);
      audit = readDemoAudit(config);
      budget = sharedBudgetSnapshot(
        config,
        audit.providers.map((p) => p.id),
      );
      await save(join(plan.public_dir, "ai-decisions.json"), { audit, budget });
      const spent =
        (budget.status.totalMicro ?? budget.status.monthlyMicro) -
        (baseline.status.totalMicro ?? baseline.status.monthlyMicro);
      admissionStopped ??= acceptanceCutoff(limits, Date.now() - started,
        audit.providers.length, spent, budget.status.blocked);
      console.log(
        JSON.stringify({
          elapsed_seconds: Math.floor((Date.now() - started) / 1000),
          provider_calls: audit.providers.length,
          reserved_or_billed_micro: spent,
          admission_stopped: admissionStopped,
          roots: audit.roots.map((r) => ({
            merchant: r.merchant,
            state: r.state,
            offer_id: r.offer_id,
            trade_id: r.trade_id,
            reason: r.close_reason,
          })),
          unresolved: audit.unresolved.length,
        }),
      );
      const candidate = await recordGenuineSettlement(plan, client, audit);
      if (candidate) {
        success = candidate;
        reason = "genuine_independent_settlement";
        if (audit.unresolved.length === 0) break;
        admissionStopped ??= "settlement_confirmed_recovering_original_intents";
      }
      if (
        audit.roots.length &&
        audit.roots.every((r) => r.state === "closed") &&
        audit.unresolved.length === 0
      ) {
        if (opportunities >= limits.max_opportunities) {
          reason = "opportunities_exhausted_without_genuine_settlement";
          break;
        }
        admissionStopped ??= acceptanceCutoff(limits, Date.now() - started,
          audit.providers.length, spent, budget.status.blocked);
        if (!admissionStopped) await purchase(plan, config, opportunities++);
      }
      if (admissionStopped && audit.unresolved.length === 0) {
        if (!success) reason = admissionStopped;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await setDemoControl(config, "paused");
    audit = readDemoAudit(config);
    const finalSettlement = demoLifecycle()?.stopped ? null : await recordGenuineSettlement(plan, client, audit);
    if (finalSettlement) {
      success = finalSettlement;
      reason = "genuine_independent_settlement";
    } else if (demoLifecycle()?.stopped) reason = "interrupted";
    else if (admissionStopped) reason = admissionStopped;
    budget = sharedBudgetSnapshot(
      config,
      audit.providers.map((p) => p.id),
    );
    limitsExceeded = audit.providers.length > limits.max_provider_calls ||
      (budget.status.totalMicro ?? budget.status.monthlyMicro) -
        (baseline.status.totalMicro ?? baseline.status.monthlyMicro) > limits.max_inference_micro;
    await save(join(plan.public_dir, "acceptance-result.json"), {
      captured_at: new Date().toISOString(),
      reason,
      interrupted: demoLifecycle()?.stopped ?? false,
      stop_signal: demoLifecycle()?.signalName ?? null,
      genuine_settlement: !!success,
      settlement: success,
      admission_stopped: admissionStopped,
      pending_followups: pendingFollowups(audit),
      unresolved_original_transactions: audit.unresolved,
      limits_exceeded: limitsExceeded,
      opportunities,
      elapsed_ms: Date.now() - started,
      limits,
      mode: "paused",
      audit,
      budget_before: baseline,
      budget_after: budget,
      spent_or_reserved_micro:
        (budget.status.totalMicro ?? budget.status.monthlyMicro) -
        (baseline.status.totalMicro ?? baseline.status.monthlyMicro),
      final_chain: demoLifecycle()?.stopped ? null : await chainSnapshot(client, player),
      reliability_gate:
        "One run only; three consecutive genuine runs remain unproven",
    });
  }
  assert(!limitsExceeded, "Acceptance allowance exceeded; evidence retained and control paused");
  return { reason, genuineSettlement: !!success, mode: "paused" };
}
async function runDemoContinuationWork(plan) {
  const config = await load(join(plan.directory, "runtime.json"));
  assert.equal((await load(config.control_file)).mode, "paused");
  const prior = await load(join(plan.public_dir, "acceptance-result.json"));
  assert.equal(prior.genuine_settlement, false);
  assert.equal(prior.opportunities, 2);
  const initial = readDemoAudit(config);
  assert(
    initial.roots.every((r) => r.state === "closed") &&
      initial.unresolved.length === 0,
  );
  const diagnostic = await load(
    join(plan.public_dir, "provider-diagnostic.json"),
  );
  assert(diagnostic.dispatched);
  const limits = demoLimits({
    duration_ms: 300000,
    max_opportunities: 1,
    max_provider_calls: 12 - initial.providers.length - 1,
    max_inference_micro: 100000,
  });
  assert(
    limits.max_provider_calls <= 3 && limits.max_provider_calls >= 2,
    "Only the remaining approved-call capacity may be used",
  );
  const beforeBudget = sharedBudgetSnapshot(config);
  assert(!beforeBudget.status.blocked);
  const old = await load(join(root, "data/living-town-runtime.ai.local.json"));
  assert.equal((await load(old.control_file)).mode, "paused");
  const quote = await nearAiPreflight(
    nearAiCredential(config.provider.key_file),
  );
  await save(
    join(plan.public_dir, "continuation-start.json"),
    {
      started_at: new Date().toISOString(),
      purpose:
        "Owner-approved extra two-crystal purchase with available replacement model",
      limits,
      before_budget: beforeBudget,
      prior_runtime_calls: initial.providers.length,
      prior_diagnostic_calls: 1,
      quote,
      helper_sha256: sha(await readFile(new URL(import.meta.url))),
    },
    true,
  );
  const client = new LivingTownClient(
      config.identity,
      createRpcTransport(plan.rpc_url),
    ),
    player = plan.roles.player.account_id,
    started = Date.now();
  let audit = initial,
    budget = beforeBudget,
    success = null,
    reason = "bounded_limit",
    admissionStopped = null,
    limitsExceeded = false;
  try {
    await purchase(plan, config, 0, "2", "purchase-continuation");
    while (!demoLifecycle()?.stopped && Date.now() - started < limits.duration_ms) {
      admissionStopped ??= acceptanceCutoff(
        limits, Date.now() - started, audit.providers.length - initial.providers.length,
        (budget.status.totalMicro ?? budget.status.monthlyMicro) -
          (beforeBudget.status.totalMicro ?? beforeBudget.status.monthlyMicro), budget.status.blocked);
      const existingSettlement = await recordGenuineSettlement(plan, client, audit);
      if (existingSettlement) {
        success = existingSettlement;
        reason = "genuine_independent_settlement";
        if (audit.unresolved.length === 0) break;
        admissionStopped ??= "settlement_confirmed_recovering_original_intents";
      }
      if (admissionStopped && audit.unresolved.length === 0) {
        reason = admissionStopped;
        break;
      }
      const before = await chainSnapshot(client, player);
      if (!await acceptanceRuntimePoll(plan, config, limits, started, !!admissionStopped))
        admissionStopped ??= "runtime_poll_failed_recovery_only";
      const after = await chainSnapshot(client, player);
      await archiveRuntimeTransactions(plan, config, before, after);
      audit = readDemoAudit(config);
      budget = sharedBudgetSnapshot(
        config,
        audit.providers.map((p) => p.id),
      );
      await save(join(plan.public_dir, "ai-decisions.json"), { audit, budget });
      const calls = audit.providers.length - initial.providers.length;
      const spent = (budget.status.totalMicro ?? budget.status.monthlyMicro) -
        (beforeBudget.status.totalMicro ?? beforeBudget.status.monthlyMicro);
      admissionStopped ??= acceptanceCutoff(limits, Date.now() - started, calls, spent, budget.status.blocked);
      const candidate = await recordGenuineSettlement(plan, client, audit);
      console.log(
        JSON.stringify({
          elapsed_seconds: Math.floor((Date.now() - started) / 1000),
          new_calls: calls,
          total_runtime_calls: audit.providers.length,
          admission_stopped: admissionStopped,
          model: quote.model,
          roots: audit.roots.map((r) => ({
            merchant: r.merchant,
            state: r.state,
            offer_id: r.offer_id,
            trade_id: r.trade_id,
            reason: r.close_reason,
          })),
          unresolved: audit.unresolved.length,
        }),
      );
      if (candidate) {
        success = candidate;
        reason = "genuine_independent_settlement";
        if (audit.unresolved.length === 0) break;
        admissionStopped ??= "settlement_confirmed_recovering_original_intents";
      }
      if (
        audit.roots.length > initial.roots.length &&
        audit.roots.every((r) => r.state === "closed") && audit.unresolved.length === 0
      ) {
        reason = "independent_decisions_did_not_settle";
        break;
      }
      if (admissionStopped && audit.unresolved.length === 0) {
        if (!success) reason = admissionStopped;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    reason = "execution_failed";
    throw e;
  } finally {
    await setDemoControl(config, "paused");
    audit = readDemoAudit(config);
    const finalSettlement = demoLifecycle()?.stopped ? null : await recordGenuineSettlement(plan, client, audit);
    if (finalSettlement) {
      success = finalSettlement;
      reason = "genuine_independent_settlement";
    } else if (demoLifecycle()?.stopped) reason = "interrupted";
    else if (admissionStopped) reason = admissionStopped;
    budget = sharedBudgetSnapshot(
      config,
      audit.providers.map((p) => p.id),
    );
    limitsExceeded = audit.providers.length - initial.providers.length > limits.max_provider_calls ||
      (budget.status.totalMicro ?? budget.status.monthlyMicro) -
        (beforeBudget.status.totalMicro ?? beforeBudget.status.monthlyMicro) > limits.max_inference_micro;
    await save(join(plan.public_dir, "continuation-result.json"), {
      captured_at: new Date().toISOString(),
      reason,
      interrupted: demoLifecycle()?.stopped ?? false,
      stop_signal: demoLifecycle()?.signalName ?? null,
      genuine_settlement: !!success,
      settlement: success,
      admission_stopped: admissionStopped,
      pending_followups: pendingFollowups(audit),
      unresolved_original_transactions: audit.unresolved,
      limits_exceeded: limitsExceeded,
      limits,
      elapsed_ms: Date.now() - started,
      mode: "paused",
      audit,
      budget_before: beforeBudget,
      budget_after: budget,
      new_provider_calls: audit.providers.length - initial.providers.length,
      total_dispatched_calls: audit.providers.length + 1,
      spent_or_reserved_micro:
        (budget.status.totalMicro ?? budget.status.monthlyMicro) -
        (beforeBudget.status.totalMicro ?? beforeBudget.status.monthlyMicro),
      final_chain: demoLifecycle()?.stopped ? null : await chainSnapshot(client, player),
      reliability_gate:
        "One genuine run only; three consecutive genuine runs remain unproven",
    });
  }
  assert(!limitsExceeded, "Continuation allowance exceeded; evidence retained and control paused");
  return { reason, genuine_settlement: !!success, mode: "paused" };
}

async function recoverDemoHelperWork(plan) {
  const lifecycle = demoLifecycle();
  const config = await load(join(plan.directory, "runtime.json"));
  await setDemoControl(config, "paused");
  const client = new LivingTownClient(config.identity, createRpcTransport(plan.rpc_url));
  const started = Date.now();
  // Reconcile original player hashes only. Never re-sign or re-broadcast them.
  for (const record of lifecycle.playerIntents.values()) {
    if (lifecycle.stopped) break;
    assert(/^[a-z0-9-]{1,90}$/.test(record.label));
    let transactionHash = record.transaction_hash;
    if (!transactionHash) {
      let intent;
      try { intent = await load(join(plan.private_dir, `${record.label}-intent.json`)); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        // A missing original file might mean lost evidence, not proof that a
        // transaction was never broadcast. Keep admission fenced for inspection.
        await lifecycle.playerIntent({ ...record, recovery_issue: "original_intent_missing" });
        continue;
      }
      assert.equal(intent.signer_id, record.signer_id);
      assert.equal(intent.receiver_id, record.receiver_id);
      transactionHash = intent.hash; // Never copy signed_base64 into evidence.
    }
    const proof = playerReceiptProof({ ...record.proof, transactionHash });
    assert.equal(proof.signerId, record.signer_id);
    assert.equal(proof.signerId, plan.roles.player.account_id);
    assert.equal(record.receiver_id, config.identity.deployment.contract_id);
    await lifecycle.playerIntent({ ...record, transaction_hash: transactionHash, proof });
    const evidence = await client.receiptEvidence(proof);
    if (["succeeded", "failed"].includes(evidence.status.kind)) {
      await archiveTransaction(plan, evidence.response, "Recovery of original player transaction; no replacement sent");
      await lifecycle.playerIntent({ ...record,
        transaction_hash: transactionHash, proof,
        status: evidence.status.kind === "succeeded" ? "confirmed" : "failed" });
    }
  }
  let audit = readDemoAudit(config);
  for (let poll = 0; poll < 3 && !lifecycle.stopped &&
    (audit.unresolved.length || audit.providers.some(p => ["prepared", "reserved", "dispatched"].includes(p.status))); poll++) {
    const remaining = 90000 - (Date.now() - started);
    if (remaining <= 0) break;
    await setDemoControl(config, "recovery_only");
    try { await runtimeOnce(plan, [], Math.min(30000, remaining)); }
    finally { await setDemoControl(config, "paused"); }
    audit = readDemoAudit(config);
  }
  await save(join(plan.public_dir, "helper-recovery.json"), {
    captured_at: new Date().toISOString(), mode: "paused", audit,
    unresolved_player_transactions: [...lifecycle.playerIntents.values()].filter(p => p.status === "unresolved"),
    interrupted: lifecycle.stopped, pending_followups: pendingFollowups(audit),
    budget: sharedBudgetSnapshot(config, audit.providers.map(p => p.id)),
    note: "Original-intent recovery only; no new inference, player signing or gameplay admission.",
  });
  return { mode: "paused", unresolved: audit.unresolved.length,
    unresolved_player_transactions: [...lifecycle.playerIntents.values()].filter(p => p.status === "unresolved").length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, file] = process.argv.slice(2);
  try {
    assert(file);
    const plan = await load(resolve(file));
    if (mode === "initialize") await initializeDemoRuntime(plan);
    else if (mode === "run")
      console.log(JSON.stringify(await runDemoAcceptance(plan)));
    else if (mode === "continue")
      console.log(JSON.stringify(await runDemoContinuation(plan)));
    else if (mode === "recover")
      console.log(JSON.stringify(await recoverDemoHelper(plan)));
    else throw Error("Use initialize|run|continue|recover <deployment-plan.json>");
  } catch (e) {
    console.error(
      JSON.stringify({
        error:
          e instanceof assert.AssertionError
            ? e.message
            : (e.code ?? "demo_acceptance_failed"),
        note: "Original evidence retained. Inspect helper-shutdown.json/helper-lifecycle.json for confirmed pause and child cleanup; reconcile unknown original work before resuming.",
      }),
    );
    if (!process.exitCode) process.exitCode = 1;
  }
}
