import {
  object,
  literal,
  bounded,
  positiveU64,
  parseU64,
  accountId,
  check,
  record,
} from "../wire.js";
import {
  livingTownCustomerPool,
  livingTownLedger,
  livingTownListing,
  livingTownProductionEffectBase,
} from "./wire.js";
import { livingTownRecipeId } from "./recipes.js";
const principal = (v: unknown): string => {
  check(
    typeof v === "string" && v.startsWith("account:"),
    "Customer operator principal required",
  );
  accountId(v.slice(8));
  return v;
};
const none = (v: unknown): null => {
  check(v === null, "Customer sink has no buyer/offer");
  return null;
};
const tradeShape = object({
  trade_id: positiveU64,
  kind: literal("customer_sale"),
  buyer: none,
  customer_pool_id: literal("town_customers"),
  seller: object({ kind: literal("player"), account_id: accountId }),
  item_id: livingTownRecipeId,
  quantity: literal("1"),
  unit_price: bounded(1n, 100n),
  total_price: bounded(1n, 100n),
  listing_id: positiveU64,
  offer_id: none,
  consumed_quantity: literal("1"),
  settled_at_ns: parseU64,
  command_principal: principal,
  command_sequence: positiveU64,
  event_sequence: positiveU64,
});
export function livingTownCustomerTrade(
  value: unknown,
): ReturnType<typeof tradeShape> {
  const t = tradeShape(value);
  check(
    t.unit_price === t.total_price &&
      BigInt(t.unit_price) <= BigInt(t.item_id === "health_potion" ? 18 : 24),
    "Customer price/demand mismatch",
  );
  return t;
}
const funded = object({
  kind: literal("customer_funded"),
  epoch: positiveU64,
  issued_gold: bounded(0n, 100n),
  pool: livingTownCustomerPool,
});
const sale = object({
  kind: literal("customer_sale"),
  trade: livingTownCustomerTrade,
  listing: livingTownListing,
  seller: livingTownLedger,
  pool: livingTownCustomerPool,
});
function decode(value: unknown) {
  const b = livingTownProductionEffectBase(value);
  const outcome =
    record(b.outcome)["kind"] === "customer_funded"
      ? funded(b.outcome)
      : sale(b.outcome);
  const r = { ...b, outcome };
  principal(r.principal);
  check(
    r.effect_revision === r.effect_event_sequence,
    "Customer effect revision mismatch",
  );
  if (outcome.kind === "customer_funded") {
    const old = BigInt(outcome.pool.gold) - BigInt(outcome.issued_gold);
    check(
      old >= 0n &&
        BigInt(outcome.issued_gold) ===
          (200n - old < 100n ? 200n - old : 100n) &&
        outcome.pool.epoch === outcome.epoch &&
        outcome.pool.last_funded_epoch === outcome.epoch,
      "Customer funding source mismatch",
    );
  } else {
    const { trade: t, listing: l, seller: s, pool } = outcome;
    check(
      t.command_principal === r.principal &&
        t.command_sequence === r.command_sequence &&
        t.event_sequence === r.effect_event_sequence &&
        l.owner.kind === "player" &&
        l.owner.account_id === t.seller.account_id &&
        s.actor.kind === "player" &&
        s.actor.account_id === t.seller.account_id &&
        BigInt(l.shop_id) > 3n &&
        l.listing_id === t.listing_id &&
        l.item_id === t.item_id &&
        l.unit_price === t.unit_price &&
        s.inventory.listing_reserved[t.item_id] === l.remaining_quantity,
      "Customer sale identity/reservation mismatch",
    );
    check(
      BigInt(
        t.item_id === "health_potion"
          ? pool.potion_units_bought
          : pool.tool_units_bought,
      ) > 0n,
      "Customer quota debit required",
    );
  }
  check(
    BigInt(outcome.pool.last_funded_epoch) <= BigInt(outcome.pool.epoch),
    "Customer epoch marker mismatch",
  );
  return r;
}
export function livingTownCustomerEffect(
  value: unknown,
): ReturnType<typeof decode> {
  return decode(value);
}
