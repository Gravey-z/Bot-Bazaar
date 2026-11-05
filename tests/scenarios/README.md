# Agent scenarios

## Living Town V2 economy fixture

Run `corepack pnpm test:economy` (or `node --test tests/scenarios/living-town-economy.test.mjs`). The same cases are discovered by `corepack pnpm test:unit`.

`living-town-economy.json` records V2-E001/config 1 tuning. `living-town-economy.mjs` is a small specification model using exact BigInt gold/quantities, a controlled clock, FIFO cost lots, reservations and source/consumption/sink counters. It imports no application worker, provider, signer, environment, network client or credential. No Docker, RPC, wallet, paid inference or external dependency is needed for the targeted command.

The tests assert four initial-price recipe pairs reach 180 gold, a 150-gold second-slot upgrade retains 30, and another pair remains affordable. At maximum raw retail bands seven pairs reach 191/41 before/after upgrade. They also check saleable-stock depletion/explicit replenishment and relisting after downtime, once-only grants/allocations (including zero allocation), customer budget/quota exhaustion, batch time, command payload conflicts, completion retries, FIFO mixed-cost partial sales, and deliberate overpriced/no-sale and below-cost behavior. The capacity boundary case explicitly lowers the model cap to four for stress; the normal fixture uses the specified 1,000-unit cap.

The diagnostic report prints actual costs, revenue, COGS, profit, cash and simulated production seconds with `mode: offline_design_model`, `liveAiEvidence: false` and `chainEvidence: false`. Expected single-player four-pair results: revenue 168, COGS 88, profit 80, 1,200 production seconds, cash 180 before/30 after upgrade. The depletion case buys all 12 saleable herbs, leaves Luna's protected 8, skips 100 epochs, issues only the current 8-herb allowance, explicitly relists, then buys again with the original player's remaining gold.

Overpriced potion at 19 or tool above 24 has no baseline customer demand. Cancel/reprice after checking cost; selling below cost can strand progression. There is no rescue grant or guaranteed recovery if no gold or usable/saleable goods remain. Worker/funding/supply outages can delay a valid sale; no model result promises a live sale time.

This fixture proves the design's bounded single-player arithmetic and modeled transitions, **not** a V2 contract implementation, wallet/authority security, persistent database/backup recovery, receipt finality, multi-player fairness or provider integration. Its in-memory command cache models payload-bound retry behavior without selecting the final P0.6 protocol or P0.7 pruning format. Production implementations must reproduce these economic outcomes with contract/worker tests. Version changes to the tuning with the sibling `Bot Bazaar docks/living town/design/economy.md`; do not change the fixture to mask an unfunded economy.

## V1 agent integration scenarios

These commands have separate provenance and outputs. Neither starts the public worker or enables a provider automatically.

| Command | Behaviour |
|---|---|
| `corepack pnpm scenario:sandbox` | Build the local toolchain/worker scenario image, start a disposable NEAR sandbox, run scripted responses through the actual prompt/schema/policy code and assert contract settlement/conservation. |
| `corepack pnpm scenario:testnet` | Write a **blocked preflight** for the genuine NEAR AI/Testnet scenario. No RPC, provider, credential loading or signing. Exit code 2 means intentionally blocked. This is not a live runner yet. |

The sandbox command requires Docker and the existing `bot-bazaar-toolchain:1.93.0-near0.22.0` image (`corepack pnpm toolchain:build`). It builds `Dockerfile.worker` and `Dockerfile.scenarios`, compiles the contract and runs only the separate Rust `scenarios` test target. The normal contract regression suite remains separate. Dependency/base-image builds can access the Internet; the actual sandbox test runs with external networking disabled. A first uncached sandbox-binary dependency may need preparation before this offline test succeeds.

Only Cargo caches/target and a new output directory are mounted into the execution container. Source is copied into the image; no repository root, real worker environment, wallet/keychain or runtime database is mounted. Its disposable sandbox accounts use SDK-generated local keys. Do not deploy this image as the public worker.

Each attempt creates a unique ignored directory under `target/scenarios/`. Controlled results are named `controlled-sandbox.json`, carry `mode: controlled_sandbox`, `provider: controlled-fixture` and `liveAiEvidence: false`. A successful report includes states, fixture decisions, public prompt hashes, actual local transaction hashes/results and exact conservation/delta assertions. These hashes are not public Testnet explorer links. Confirmed local calls are also retained in `controlled-transactions.ndjson`; failed attempts retain a failed report instead of becoming success or being retried automatically.

The deterministic decisions are Rex's four-crystal purchase proposal at 24 gold, Luna's acceptance, Rex's four-crystal relisting at seven gold, and holds for Luna's followup and Bolt. Policy prerequisites deactivate Rex's cheap listing and reduce Luna's listed capacity first. Prerequisites execute with the actor's next action ID; the original selected terms are revalidated after refreshing state, without another fixture decision. Dynamic sandbox accounts/timestamps/hashes vary; economic choices and expected deltas are deterministic.

This rehearsal tests prompt construction, schema/policy enforcement, prerequisites and real sandbox contract results. It does **not** run the production Testnet-only RPC/signer adapter, durable worker scheduling/recovery loop or genuine inference/accounting. Their existing unit tests remain separate. The view bridge reports an unavailable block hash as null rather than inventing one.

The real-provider definition is `near-ai-testnet.json`. Its separate `near-ai-testnet-preflight.json` always identifies unexecuted/blocked status. P3.14 remains open until a real-provider runtime is wired. The owner has reserved a small credit balance: selecting a model or storing a key does not authorize spending it. Live execution needs explicit approval, a reviewed maximum spend, verified tokenizer/pricing, durable usage continuity, controller fencing and a fresh prepared market. No execute/approval flag bypass exists, and no controlled provider is an outage fallback.
