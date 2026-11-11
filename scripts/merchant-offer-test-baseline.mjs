// Read-only preparation for the schema-1 migration test. Never sends a transaction.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const cfg = JSON.parse(
  await readFile(new URL("config/living-town-testnet.json", root), "utf8"),
);
const directory = new URL("data/merchant-offers-phase1/", root);
const artifact = new URL("deployed-schema1.wasm", directory);
const metadata = new URL("deployed-schema1.json", directory);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let decoded = 0n;
for (const ch of cfg.identity.codeHash) {
  const digit = alphabet.indexOf(ch);
  if (digit < 0) throw new Error("Invalid pinned code hash");
  decoded = decoded * 58n + BigInt(digit);
}
const expectedSha256 = decoded.toString(16).padStart(64, "0");
if (
  expectedSha256.length !== 64 ||
  cfg.public.networkId !== "testnet" ||
  cfg.public.contractId !== cfg.identity.deployment.contract_id
)
  throw new Error("Expected a pinned Testnet deployment");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let cached;
try {
  cached = await readFile(artifact);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (cached) {
  if (sha256(cached) !== expectedSha256)
    throw new Error(
      "Existing baseline differs from the pinned code; refusing replacement",
    );
  const record = JSON.parse(await readFile(metadata, "utf8"));
  if (
    record.sha256 !== expectedSha256 ||
    record.code_hash !== cfg.identity.codeHash
  )
    throw new Error("Baseline metadata differs from the pinned artifact");
  console.log("Verified cached pinned schema-1 test baseline.");
} else {
  const endpoint = new URL(cfg.public.rpcUrl);
  if (endpoint.protocol !== "https:")
    throw new Error("Test baseline RPC must use HTTPS");
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "merchant-offer-code-read",
      method: "query",
      params: {
        request_type: "view_code",
        account_id: cfg.public.contractId,
        finality: "final",
      },
    }),
  });
  if (!response.ok || !response.body)
    throw new Error(`RPC HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 2 * 1024 * 1024)
      throw new Error("Baseline RPC response exceeds 2 MiB");
    chunks.push(part);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (result.error || result.result?.hash !== cfg.identity.codeHash)
    throw new Error("RPC code differs from pinned deployment");
  const bytes = Buffer.from(result.result.code_base64, "base64");
  if (sha256(bytes) !== expectedSha256)
    throw new Error("Downloaded WASM does not match its pinned code hash");
  const record = {
    kind: "read_only_testnet_code_download_no_transactions",
    contract_id: cfg.public.contractId,
    code_hash: cfg.identity.codeHash,
    sha256: expectedSha256,
    block_height: result.result.block_height,
    block_hash: result.result.block_hash,
    bytes: bytes.length,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(artifact, bytes, { flag: "wx" });
  await writeFile(metadata, JSON.stringify(record, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(`Saved pinned test baseline: ${fileURLToPath(artifact)}`);
}
