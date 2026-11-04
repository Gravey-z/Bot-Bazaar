import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createRpcTransport } from "../packages/chain/dist/index.js";
import {
  rehearsalCommands,
  validateRehearsalManifest,
  verifyRehearsalSeed,
  runtimeMethods,
} from "./rehearsal-plan.mjs";

export function transactionHash(output) {
  const matches = [
    ...output.matchAll(
      /Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])/gi,
    ),
  ];
  assert.equal(
    matches.length,
    1,
    "One public transaction ID is required; preserve the operation journal",
  );
  return matches[0][1];
}

export async function accountPresence(plan, id, fetcher = fetch) {
  const response = await fetcher(plan.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "rehearsal-presence",
      method: "query",
      params: {
        request_type: "view_account",
        account_id: id,
        finality: "final",
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok && response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 65536) {
      await reader.cancel();
      throw new Error("Account presence response exceeds bound");
    }
    chunks.push(part.value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(value.id, "rehearsal-presence");
  if (value.error) {
    assert.equal(
      value.error.cause?.name,
      "UNKNOWN_ACCOUNT",
      "Account absence must be explicit, not a generic RPC rejection",
    );
    return null;
  }
  assert.ok(
    value.result &&
      typeof value.result.amount === "string" &&
      typeof value.result.code_hash === "string",
  );
  return value.result;
}

async function preflight(plan, step, directory) {
  const account = await accountPresence(plan, step.account);
  if (step.id.startsWith("create-")) {
    assert.equal(
      account,
      null,
      "Account already exists; do not recreate or replace its keys",
    );
    const rpc = createRpcTransport(plan.rpcUrl);
    const [funder, config] = await Promise.all([
      accountPresence(plan, plan.fundingAccount),
      rpc("EXPERIMENTAL_protocol_config", { finality: "final" }),
    ]);
    const available =
      BigInt(funder.amount) -
      BigInt(funder.storage_usage) *
        BigInt(config.runtime_config.storage_amount_per_byte);
    const transfer =
      step.id === "create-contract"
        ? 4000000000000000000000000n
        : step.id === "create-player"
          ? 500000000000000000000000n
          : 400000000000000000000000n;
    assert.ok(
      available >= transfer + 300000000000000000000000n,
      "Insufficient Testnet balance after retained storage/gas reserve",
    );
  } else if (step.id === "deploy-initialize") {
    const artifact = await readFile(join(directory, "contract.wasm"));
    const digest = createHash("sha256").update(artifact).digest();
    const requireWorker = createRequire(
      new URL("../apps/worker/package.json", import.meta.url),
    );
    assert.equal(
      requireWorker("near-api-js").baseEncode(digest),
      plan.identity.codeHash,
      "Prepared contract artifact changed",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "initialize.json"), "utf8")),
      {
        owner_account_id: plan.identity.ownerId,
        merchant_controllers: plan.identity.controllers,
      },
    );
    assert.ok(
      account && account.code_hash === "11111111111111111111111111111111",
      "Only a fresh empty contract account can be deployed",
    );
    for (const name of ["contract", "rex", "luna", "bolt", "player"]) {
      const record = JSON.parse(
        await readFile(
          join(directory, "operations", `create-${name}.json`),
          "utf8",
        ),
      );
      assert.equal(
        record.status,
        "confirmed",
        "Finish/reconcile account provisioning before deployment",
      );
    }
  } else if (step.id === "register-player") {
    const seed = await verifyRehearsalSeed(plan);
    await writeFile(
      join(directory, `seed-before-registration-${Date.now()}.json`),
      JSON.stringify(seed, null, 2) + "\n",
      { flag: "wx" },
    );
  } else if (step.id.startsWith("restrict-")) {
    assert.ok(account, "Controller account is unavailable");
    const rpc = createRpcTransport(plan.rpcUrl);
    const keys = await rpc("query", {
      request_type: "view_access_key_list",
      account_id: step.account,
      finality: "final",
    });
    assert.ok(
      keys.keys.every((key) => key.access_key.permission === "FullAccess"),
      "A restricted key already exists; reconcile rather than generating another",
    );
  }
}

async function confirm(plan, step, hash, signer) {
  const rpc = createRpcTransport(plan.rpcUrl);
  const result = await rpc("tx", {
    tx_hash: hash,
    sender_account_id: signer,
    wait_until: "FINAL",
  });
  assert.equal(result.final_execution_status, "FINAL");
  assert.equal(result.transaction.hash, hash);
  assert.equal(result.transaction.signer_id, signer);
  assert.equal(
    result.transaction.receiver_id,
    step.id.startsWith("create-") || step.id.startsWith("restrict-")
      ? step.account
      : plan.identity.contractId,
  );
  assert.ok(
    result.status && Object.hasOwn(result.status, "SuccessValue"),
    "Final transaction did not succeed",
  );
  assert.ok(
    result.receipts_outcome.every(
      (outcome) => !Object.hasOwn(outcome.outcome.status, "Failure"),
    ),
    "A receipt failed",
  );
  const actions = result.transaction.actions;
  if (step.id.startsWith("create-")) {
    assert.equal(actions.length, 3);
    assert.ok(
      actions.includes("CreateAccount") ||
        actions.some((action) => Object.hasOwn(action, "CreateAccount")),
    );
    assert.ok(actions.some((action) => Object.hasOwn(action, "Transfer")));
    assert.ok(actions.some((action) => Object.hasOwn(action, "AddKey")));
    const transfer = actions.find((action) => action.Transfer).Transfer;
    const expected =
      step.id === "create-contract"
        ? "4000000000000000000000000"
        : step.id === "create-player"
          ? "500000000000000000000000"
          : "400000000000000000000000";
    assert.equal(transfer.deposit, expected);
    assert.equal(
      actions.find((action) => action.AddKey).AddKey.access_key.permission,
      "FullAccess",
    );
    assert.ok(await accountPresence(plan, step.account));
  } else if (step.id.startsWith("restrict-")) {
    assert.equal(actions.length, 1);
    const added = actions[0].AddKey;
    assert.ok(added);
    const permission = added.access_key.permission.FunctionCall;
    assert.equal(permission.receiver_id, plan.identity.contractId);
    assert.equal(permission.allowance, "100000000000000000000000");
    assert.deepEqual(
      [...permission.method_names].sort(),
      [...runtimeMethods].sort(),
    );
    const key = await rpc("query", {
      request_type: "view_access_key",
      account_id: step.account,
      public_key: added.public_key,
      finality: "final",
    });
    assert.deepEqual(key.permission.FunctionCall, permission);
    return {
      hash,
      signer,
      publicKey: added.public_key,
      permission,
      finalExecutionStatus: "FINAL",
    };
  } else {
    const calls = actions.filter((action) => action.FunctionCall);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].FunctionCall.method_name,
      step.id === "deploy-initialize" ? "initialize_market" : "register_player",
    );
    assert.equal(calls[0].FunctionCall.deposit, "0");
    const args = JSON.parse(
      Buffer.from(calls[0].FunctionCall.args, "base64").toString("utf8"),
    );
    assert.deepEqual(
      args,
      step.id === "deploy-initialize"
        ? {
            owner_account_id: plan.identity.ownerId,
            merchant_controllers: plan.identity.controllers,
          }
        : {},
    );
    if (step.id === "deploy-initialize") {
      assert.ok(actions.some((action) => action.DeployContract));
      const seed = await verifyRehearsalSeed(plan);
      return { hash, signer, finalExecutionStatus: "FINAL", seed };
    }
  }
  return { hash, signer, finalExecutionStatus: "FINAL" };
}

export async function executeRehearsalStep(
  manifestPath,
  stepId,
  nearExecutable,
  dependencies = {},
) {
  const directory = dirname(resolve(manifestPath));
  const plan = JSON.parse(await readFile(manifestPath, "utf8"));
  validateRehearsalManifest(plan);
  const step = rehearsalCommands(plan, directory).steps.find(
    (step) => step.id === stepId,
  );
  assert.ok(step, "Unknown rehearsal step");
  await (dependencies.preflight ?? preflight)(plan, step, directory);
  const operations = join(directory, "operations");
  await mkdir(operations, { recursive: true });
  const file = join(operations, `${stepId}.json`);
  const signer = stepId.startsWith("create-")
    ? plan.fundingAccount
    : stepId === "register-player"
      ? plan.player
      : step.account;
  const record = {
    schema: plan.schema,
    runId: plan.runId,
    stepId,
    signer,
    receiver:
      stepId === "register-player" ? plan.identity.contractId : step.account,
    status: "unknown",
    startedAt: new Date().toISOString(),
    providerRequests: 0,
  };
  // Exclusive journal entry precedes any key generation, signing or broadcast.
  // An interrupted/failed CLI invocation can never be automatically replayed.
  await writeFile(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  const result = (dependencies.run ?? spawnSync)(nearExecutable, step.args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const output = stripVTControlCharacters(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  // Never log raw CLI output: generated keys stay in the OS keychain.
  const hash = transactionHash(output);
  record.transactionHash = hash;
  await writeFile(file, JSON.stringify(record, null, 2) + "\n");
  assert.ok(
    !result.error && result.status === 0,
    "CLI outcome uncertain; reconcile the original hash",
  );
  const evidence = await (dependencies.confirm ?? confirm)(
    plan,
    step,
    hash,
    signer,
  );
  record.status = "confirmed";
  record.confirmedAt = new Date().toISOString();
  record.evidence = evidence;
  await writeFile(file, JSON.stringify(record, null, 2) + "\n");
  return { stepId, status: record.status, transactionHash: hash };
}

export async function reconcileRehearsalStep(
  manifestPath,
  stepId,
  dependencies = {},
) {
  const directory = dirname(resolve(manifestPath));
  const plan = JSON.parse(await readFile(manifestPath, "utf8"));
  validateRehearsalManifest(plan);
  const step = rehearsalCommands(plan, directory).steps.find(
    (step) => step.id === stepId,
  );
  assert.ok(step);
  const file = join(directory, "operations", `${stepId}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(record.runId, plan.runId);
  assert.equal(record.stepId, stepId);
  assert.equal(record.status, "unknown");
  assert.match(record.transactionHash, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const signer = stepId.startsWith("create-")
    ? plan.fundingAccount
    : stepId === "register-player"
      ? plan.player
      : step.account;
  assert.equal(record.signer, signer);
  const evidence = await (dependencies.confirm ?? confirm)(
    plan,
    step,
    record.transactionHash,
    signer,
  );
  await writeFile(
    file,
    JSON.stringify(
      {
        ...record,
        status: "confirmed",
        confirmedAt: new Date().toISOString(),
        evidence,
      },
      null,
      2,
    ) + "\n",
  );
  return {
    stepId,
    status: "confirmed",
    transactionHash: record.transactionHash,
    resubmitted: false,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    assert.equal(process.argv.length, 5);
    const result =
      process.argv[2] === "reconcile"
        ? await reconcileRehearsalStep(process.argv[3], process.argv[4])
        : await executeRehearsalStep(...process.argv.slice(2));
    console.info(JSON.stringify(result));
  } catch {
    console.error(
      "Rehearsal step stopped. Preserve its operation journal; check public preflight and reconcile any original transaction before retrying. No raw keychain output is displayed.",
    );
    process.exitCode = 1;
  }
}
