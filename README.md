# Bot Bazaar

A marketplace powered by AI merchants, built on the NEAR blockchain.

The active public target is `config/living-town-testnet.json`, currently Testnet
contract `contract.bb-demo-171aea0e7c.testnet` with state schema 2. Development web
uses <http://127.0.0.1:4200/?town=phaser>; the built local preview uses port 4201,
and the separate reader uses <http://127.0.0.1:3011/health>. Services start only
when you run their commands. The current saved demo runtime is paused. Historical
Day 2/3 successes below belong to earlier deployments; the current fresh demo has
not yet demonstrated an independent live AI-to-AI settlement.

The shared hackathon inference budget is **$10 total**, paced at **up to $2 per
rolling 24 hours**. Existing usage counts toward that total and does not renew
monthly. Never publish private credentials or execution journals. Preserve the
current demo's original `data/phase7-demo` configuration, journals and budget
authority when resuming it; fresh setup is not a migration or recovery shortcut.

Day 2 runtime instructions and sanitized evidence are in the sibling documentation
at `v3/DAY-02-RUNTIME.md` and `v3/day-02/live-economy.json`. Its executable is
`apps/worker/dist/living-town-runtime.js --config <absolute-runtime-config>`;
the public reader remains a separate process. Preserve the original execution,
facts and independent witness databases when restarting; never initialize them
again. The Compose package below still contains the frontend and reader only.

Day 3's provider setup, one-way budget enrollment, bounded live test and limitations
are documented in `v3/DAY-03-AI-REACTION.md`, with sanitized evidence at
`v3/day-03/live-ai-reaction.json` in the sibling documentation. The enrolled local
journal now requires `data/living-town-runtime.ai.local.json`, even when paused;
the original rules-only config cannot replace its shared budget authority. The
player assistant and continuous idle repricing remain deferred.

Merchant personalities now follow the owner's [character documents](characters/README.md),
filtered to current game mechanics. Each new AI request includes only that
merchant's supported goals/behaviour and fresh facts. The existing action,
permission and budget checks remain authoritative; future character features
are not enabled by adding prose to a prompt.

For local frontend development, run `corepack pnpm dev:web` and open
<http://127.0.0.1:4200/?town=phaser>. This now generates the local Living Town
profile by default before building and watching. It also builds and starts the local
reader and the guest backend when its one-time configuration is present. See
[local development setup](docs/LOCAL-DEVELOPMENT.md). The reader must allow the exact frontend origin
`http://127.0.0.1:4200`. The local reader generator also allows the production preview on
port 4201. An existing reader config must include each origin you use.

The reproducible Living Town build now uses the secret-free reviewed identity in
`config/living-town-testnet.json`. From this repository root, with Node 24.16.0
and Corepack installed:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build:demo
corepack pnpm start:demo
```

Open <http://127.0.0.1:4201/>. The start command validates the actual build before
serving it; it does not copy anything from private setup artifacts. V2 generation
ignores legacy `apps/web/.env` settings. Generated public config, deployment and
`living-town.json` all identify the same reviewed V2 contract. The output scanner
checks the full deployment identity, including code, config, genesis and authorities.

The fixed-town Phaser prototype is available at
<http://127.0.0.1:4201/?town=phaser>, using the supplied market-square and merchant
art. It keeps the existing wallet reviews and shop manager, with clickable
locations and keyboard-accessible HTML controls. The original default presentation
remains until actual browser/mobile/wallet acceptance is complete. See the sibling
documentation's `v3/PHASER-PROTOTYPE.md` for verification and remaining checks.

Run the read-only V2 service in a second terminal. To create a **new local reader**
without any existing setup files:

```powershell
corepack pnpm --filter @bot-bazaar/worker build
corepack pnpm setup:reader
$readerConfig = node scripts/write-living-town-reader-config.mjs --print-path
node apps/worker/dist/living-town.js --config "$readerConfig" --initialize
```

The generator refuses to overwrite an existing config. On subsequent starts,
reuse that file and omit `--initialize`. It uses a separate persistent
`data/deployments/<contract>-<identity-digest>/projection` directory and 15-second polling. Preserve any existing
reader's configuration/state if it contains history; do not switch an established
service to a fresh projection as a recovery shortcut. Only one service may bind
port 3011. Check <http://127.0.0.1:3011/health>; its role is `read_projection`.
This service does not run customers, NPC signing or model inference. A fresh
projection cannot reconstruct complete receipt/history provenance.

For public hosting, set `$env:V2_WORKER_URL = 'https://YOUR-READER-DOMAIN'` to the
actual deployed reader origin, then run `corepack pnpm build:demo:public`.
Public builds reject loopback, HTTP and IP-literal service URLs. HTTPS availability
and exact reader CORS approval for the hosted frontend still need live checks.
`corepack pnpm check:web-output` defaults to public V2 validation;
`corepack pnpm check:web-output:local` validates the local artifact. Both accept
no missing V2 profile or disagreement between its configuration and the deployment.

Classic/replay builds remain available explicitly through
`corepack pnpm build:web:classic` (using the existing classic public environment)
and `corepack pnpm check:web-output:classic`. Generic `corepack pnpm build` now
defaults to Living Town with a local target; use `build:demo` or `build:demo:public`
to select and validate the intended release explicitly. These commands
share `apps/web/dist/browser`, so rebuild the selected experience before serving it.

For a new runtime setup, build the packages/worker first, then run
`corepack pnpm setup:runtime --keys <absolute-restricted-key-directory>`.
The generator takes identity from the active public profile and public key scopes
from `config/living-town-runtime-public.json`, referencing `runtime-<lane>.json`
inside your explicit key directory. It reads no private keys and performs no
chain calls. It writes deployment-specific runtime/control files, starts paused
with inference disabled, and refuses existing runtime state. Installed restricted
keys still require runtime preflight. Supply `--public-keys <absolute-public-manifest>`
only for reviewed replacement public key metadata matching the active identity.
Do not point a newly generated runtime at the existing demo's keys to bypass its
original journal, witness or shared-budget continuity. Hosting/evidence-channel
packaging remains separate work.

`corepack pnpm release:candidate <new-workspace-manifest.json>` creates an offline
source candidate using the active public profile and matching examples. This does
not reverify the live contract or establish a passing build, wallet or hosting gate.

For the outstanding real-wallet smoke, use Meteor with a funded **Testnet** account.
The adapter pins `@hot-labs/near-connect` 0.11.4 and Meteor executor commit
`911f9d645b912fadbb1af0d0953cba44b005c82f`. Allow wallet popups. Connect and check
the displayed account/network, register, claim an available shop and buy one raw
material. Record each transaction hash and inspect its successful receipt in
<https://testnet.nearblocks.io/>. Reject one approval, retry explicitly, then
refresh/reconnect and verify the same account/shop/assets return. An unknown
transaction must reconcile its original hash before another request is made.
Setup-created accounts are not automatically available in Meteor; use a wallet
account you control. Never paste keys or recovery phrases into chat or public files.
Browser approval/rejection and real-player hashes remain unverified until this
sequence is actually performed.

For a local economy rehearsal, run `corepack pnpm dev:rehearsal` and open
<http://127.0.0.1:4210/>. This separate practice page uses simulated time and
deterministic customers, with no wallet, blockchain or AI calls. State survives
page refreshes but resets when the server stops. It does not configure or replace
the Angular app or count as a real-wallet playtest.

For OMV7, the V2 frontend and persistent read API can be built and run entirely
with Docker Compose. Copy `.env.v2.example` to `.env.v2`, explicitly allow creation
only for a new empty reader volume, then run:

```sh
docker compose --env-file .env.v2 -f compose.v2.yaml up -d --build
```

This Linux stack binds the frontend to host loopback port 4201 and the V2 reader
to 3011 for the existing OMV7 tunnel. Public use requires the real API HTTPS URL
and exact frontend origin in `.env.v2`, then rebuilding. The projection lives in
a persistent named volume; ordinary restarts do not reset it. This stack runs the
current frontend and **read projection**; customer/NPC automation and real AI
transport still require the Day 2/3 runtime work. Cloudflare hostname routing and
Pages publishing are separate account actions. The detailed operator guide is
`Bot Bazaar docks/v3/OMV7-COMPOSE.md` in the sibling documentation workspace.
