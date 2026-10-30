import { readFile } from "node:fs/promises";

// Read-only pricing evidence. Inputs are measured local workloads, never
// predictions of deployed execution or proof that an account is funded.
const inputPath = process.argv[2];
if (!inputPath || process.argv.length !== 3) {
  throw new Error(
    "Usage: node scripts/quote-testnet-limits.mjs <measurements.json>",
  );
}
const measurements = JSON.parse(await readFile(inputPath, "utf8"));
function decimal(value, field) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} must be a positive decimal string`);
  }
  return BigInt(value);
}
const bytes = decimal(measurements.storage_total_bytes, "storage_total_bytes");
const budget = decimal(measurements.attached_gas_budget, "attached_gas_budget");
const samples = Object.entries(measurements.gas_burnt_samples);
if (!samples.length)
  throw new Error("At least one measured gas sample is required");
for (const [name, gas] of samples) {
  if (decimal(gas, name) >= budget)
    throw new Error(`${name} exceeds gas budget`);
}

const rpcUrl = "https://rpc.testnet.near.org";
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "p219", method, params }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !body.result) throw new Error(`RPC ${method} failed`);
  return body.result;
}

const status = await rpc("status", {});
if (status.chain_id !== "testnet" || status.sync_info.syncing) {
  throw new Error("RPC must be a synchronized Testnet node");
}
const block = await rpc("block", { finality: "final" });
const blockId = block.header.hash;
const [config, gas] = await Promise.all([
  rpc("EXPERIMENTAL_protocol_config", { block_id: blockId }),
  rpc("gas_price", [blockId]),
]);
const byteCost = decimal(
  config.runtime_config.storage_amount_per_byte,
  "byte cost",
);
const gasPrice = decimal(gas.gas_price, "gas price");
const limits = config.runtime_config.wasm_config.limit_config;
if (budget > BigInt(limits.max_total_prepaid_gas)) {
  throw new Error("Requested gas budget exceeds the observed protocol limit");
}
const stake = bytes * byteCost;
const near = (value) => {
  const unit = 10n ** 24n;
  return `${value / unit}.${(value % unit).toString().padStart(24, "0")}`;
};
const amount = (value) => ({ yoctonear: value.toString(), near: near(value) });
console.log(
  JSON.stringify(
    {
      observed_at_utc: new Date().toISOString(),
      rpc_url: rpcUrl,
      chain_id: status.chain_id,
      finalized_block: {
        hash: blockId,
        height: block.header.height,
        timestamp_ns: block.header.timestamp_nanosec,
      },
      protocol_version: config.protocol_version,
      storage_amount_per_byte: byteCost.toString(),
      gas_price: gasPrice.toString(),
      max_total_prepaid_gas: String(limits.max_total_prepaid_gas),
      measurements,
      storage_stake: amount(stake),
      storage_with_25_percent_headroom: amount(stake + (stake + 3n) / 4n),
      estimated_sample_fees: Object.fromEntries(
        samples.map(([name, value]) => [
          name,
          amount(BigInt(value) * gasPrice),
        ]),
      ),
      attached_gas_budget_cost: amount(budget * gasPrice),
      one_hundred_budgeted_calls_cost: amount(100n * budget * gasPrice),
      limitation:
        "Local sandbox gas priced at a finalized Testnet block; actual deployment receipts, account funding and future gas prices require rechecking.",
    },
    null,
    2,
  ),
);
