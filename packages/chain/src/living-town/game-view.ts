import { accountId, array, boolean, check, nullable, object } from "../wire.js";
import { livingTownTown, livingTownPlayer, livingTownShop, livingTownLedger,
  livingTownListing, livingTownUpgrade } from "./wire.js";
import { livingTownRecipe } from "./recipes.js";
import { livingTownProductionJob } from "./production.js";
import { livingTownOffer } from "./offers.js";
import { livingTownAssistantPolicy } from "./assistant-policy.js";
import { canonicalLivingTownJson } from "./json.js";

export const livingTownShopDirectory = object({
  shops: array(livingTownShop, 50),
  next_cursor: nullable((value: unknown): string => {
    check(typeof value === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(value), "invalid directory cursor");
    return value;
  }),
});

const shape = object({
  account: accountId,
  town: livingTownTown,
  player: nullable(livingTownPlayer),
  shop: nullable(livingTownShop),
  ledger: nullable(livingTownLedger),
  listings: array(livingTownListing, 18),
  ownListings: array(livingTownListing, 2),
  recipes: array(livingTownRecipe, 2),
  production: object({ items: array(livingTownProductionJob, 258), historyGap: boolean }),
  offers: array(livingTownOffer, 140),
  offersHistoryGap: boolean,
  upgrade: nullable(livingTownUpgrade),
  assistantPolicy: nullable(livingTownAssistantPolicy),
  assistantRepriceAvailable: boolean,
});

/** Display-only aggregate. Transaction preparation must still use live chain checks. */
export function livingTownGameView(value: unknown): ReturnType<typeof shape> {
  const view = shape(value);
  check(view.player === null || view.player.account_id === view.account, "view player mismatch");
  check((view.player === null) === (view.ledger === null) &&
    (view.player?.shop_id ?? null) === (view.shop?.shop_id ?? null), "incomplete player view");
  check(view.player === null || canonicalLivingTownJson(view.player.ledger) === canonicalLivingTownJson(view.ledger),
    "view player ledger mismatch");
  check(view.shop === null || (view.shop.owner.kind === "player" &&
    view.shop.owner.account_id === view.account && view.player?.shop_id === view.shop.shop_id),
    "view shop owner mismatch");
  check(view.ledger === null || (view.ledger.actor.kind === "player" &&
    view.ledger.actor.account_id === view.account), "view ledger mismatch");
  check(view.ownListings.every(l => l.shop_id === view.shop?.shop_id &&
    l.owner.kind === "player" && l.owner.account_id === view.account), "view listings mismatch");
  check(view.production.items.every(j => j.shop_id === view.shop?.shop_id), "view jobs mismatch");
  check(view.upgrade === null || view.upgrade.shop_id === view.shop?.shop_id, "view upgrade mismatch");
  check(view.assistantPolicy === null || view.assistantPolicy.shop_id === view.shop?.shop_id,
    "view assistant mismatch");
  return view;
}
