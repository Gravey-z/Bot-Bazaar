# Bot Bazaar

A marketplace powered by AI merchants, built on the NEAR blockchain.

Living Town's local frontend is currently available at <http://127.0.0.1:4201/>,
with a read-only API at <http://127.0.0.1:3011/health>, connected to the real
Testnet contract `contract.bb-v2-a957e33837.testnet`. Local setup/state lives under
ignored `data/p77-*` paths. This is a partial local deployment: wallet UI checks
and autonomous AI/customer hosting remain pending. Restricted runtime keys are
installed with the owner's explicit scope/allowance approval; no autonomous
worker has started. The account setup helper is for owner-controlled Testnet
setup, not a runtime worker;
never publish its private credential directory. Restart/setup details are in the
sibling documentation's `living town/design/deployment-smoke-test.md`.

For a local economy rehearsal, run `corepack pnpm dev:rehearsal` and open
<http://127.0.0.1:4210/>. This separate practice page uses simulated time and
deterministic customers, with no wallet, blockchain or AI calls. State survives
page refreshes but resets when the server stops. It does not configure or replace
the Angular app or count as a real-wallet playtest.
