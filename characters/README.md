# Merchant character sources

`rex.md`, `luna.md` and `bolt.md` are unchanged copies of the owner's character
documents from the sibling documentation's `characters/` directory. They include
ideas beyond the current game; they are reference material and are **not** sent
directly to the model.

The executable profiles are in
[`merchant-characters.ts`](../apps/worker/src/private/living-town/merchant-characters.ts).
They retain the supported goals, motivation weights, voice and decision preferences:

- Rex: wealth, opportunity, liquidity, reliable crystal sales and bounded pricing.
- Luna: fair herb pricing, shortage reduction and preserving essential reserves.
- Bolt: real iron-tool production, material planning and reliable workshop output.

Loans, gifts, barter, negotiation, research, new recipes, relationship scores and
workshop upgrades are excluded. Luna's alchemist background does not unlock NPC
potion crafting; she currently operates the herb shop. Bolt's production choices
use the existing recipe and deterministic completion checks.

Every newly prepared NEAR AI request includes only its merchant's filtered profile
and newly collected facts. The same model and shared budget remain in use. Cached
decisions and recovery preserve their original identity instead of paying to
regenerate a request. Profiles do not create new inference triggers or persistent
relationship/project systems.

When editing these source documents, update the supported executable profile and
rebuild the worker. Editing Markdown alone does not hot-reload a deployed agent.
The current profile version is `merchant-characters-v1`; the provider prompt
version is `town-near-ai-v3-characters`. Changing profiles should update the
profile version. Each request includes a hash of its selected profile and the
provider audit records the prompt version.
