// Controlled crash helper. No real RPC, services, paid inference or user credentials.
import { adapterFixture } from "./living-town-adapter.mjs";
import { TownProposalDelivery } from "../../dist/private/living-town/proposals.js";
const f = await adapterFixture(process.argv[2], {
  negotiated: true,
  crashAt: "after_network",
  propose: async (c) =>
    new TownProposalDelivery(
      {
        schema: "living-town-proposal-v1",
        tick_id: c.tickId,
        market_revision: c.facts.town.market_revision,
        merchant_id: c.merchant,
        reason: "controlled child buyer decision",
        action: {
          type: "propose_trade",
          side: "buy",
          counterparty: "luna",
          item_id: "crystal",
          quantity: "2",
          unit_price: "5",
        },
      },
      "model_proposal",
      `controlled:${c.tickId}`,
    ),
});
await f.simulation.poll();
f.close();
throw Error("expected controlled crash was not reached");
