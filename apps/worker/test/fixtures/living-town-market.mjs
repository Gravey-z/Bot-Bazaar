// Controlled listing terms for older snapshot-only tests; not captured RPC evidence.
export function controlledMarket(town) {
  return {
    ...town,
    data: {
      items: [
        ["rex", "crystal", "4"],
        ["luna", "herb", "3"],
        ["bolt", "wood", "2"],
        ["bolt", "iron", "5"],
      ].map(([merchant, item, price], i) => {
        const index = ["rex", "luna", "bolt"].indexOf(merchant),
          quantity =
            town.data.npc_ledgers[index].inventory.listing_reserved[item];
        return {
          listing_id: String(i + 1),
          shop_id: String(index + 1),
          owner: { kind: "merchant", merchant_id: merchant },
          item_id: item,
          remaining_quantity: quantity,
          unit_price: price,
          revision: "1",
          active: quantity !== "0",
        };
      }),
      next_after_id: "4",
      has_more: false,
      history_gap: false,
      pruned_through: "0",
    },
  };
}
