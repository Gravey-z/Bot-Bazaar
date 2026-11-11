use super::*;
use ownership::{Outcome, args, next};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MerchantId {
    Rex,
    Luna,
    Bolt,
}
impl MerchantId {
    fn index(self) -> usize {
        self as usize
    }
}

// Shared promises are explicit even before offer/production methods are added.
#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub(crate) struct Reservations {
    pub listing: Inventory,
    pub trade: Inventory,
    pub output: Inventory,
    pub inbound: Inventory,
    pub gold_trade: u64,
    pub gold_inbound: u64,
}
pub(crate) fn ledger(
    actor: Value,
    gold: u64,
    held: Inventory,
    revision: u64,
    r: &Reservations,
) -> Value {
    let mut available = held;
    for i in 0..6 {
        available.quantities[i] = held.quantities[i]
            .checked_sub(r.listing.quantities[i])
            .and_then(|v| v.checked_sub(r.trade.quantities[i]))
            .expect("valid reservations");
    }
    json!({"actor":actor,"revision":revision.to_string(),"gold":{"held":gold.to_string(),"available":gold.checked_sub(r.gold_trade).expect("gold reservations").to_string(),"trade_reserved":r.gold_trade.to_string(),"trade_inbound_reserved":r.gold_inbound.to_string()},"inventory":{"held":held.view(),"available":available.view(),"listing_reserved":r.listing.view(),"trade_reserved":r.trade.view(),"production_output_reserved":r.output.view(),"trade_inbound_reserved":r.inbound.view()}})
}
pub(crate) fn npc_ledger(index: usize, npc: &Npc) -> Value {
    let mut r = npc.reservations.clone();
    for (slot, listing) in npc.listings.iter().enumerate() {
        r.listing.quantities[slot] = listing.as_ref().map_or(0, |l| l.quantity);
    }
    ledger(
        json!({"kind":"merchant","merchant_id":MERCHANTS[index]}),
        npc.gold,
        npc.held,
        npc.ledger_revision,
        &r,
    )
}
fn listing_view(index: usize, item: Item, listing: &Listing) -> Value {
    json!({"listing_id":listing.id.to_string(),"shop_id":(index+1).to_string(),"owner":{"kind":"merchant","merchant_id":MERCHANTS[index]},"item_id":item,"remaining_quantity":listing.quantity.to_string(),"unit_price":listing.unit_price.to_string(),"revision":listing.revision.to_string(),"active":listing.quantity>0})
}
#[near(serializers=[borsh])]
#[derive(Clone)]
pub(crate) enum Trade {
    Raw(RawTrade),
    Customer(super::customers::SaleTrade),
    Merchant(super::merchant_trading::MerchantTrade),
    Negotiated(super::offers::NegotiatedTrade),
}
impl Trade {
    fn view(&self) -> Value {
        match self {
            Self::Raw(t) => t.view(),
            Self::Customer(t) => t.view(),
            Self::Merchant(t) => t.view(),
            Self::Negotiated(t) => t.view(),
        }
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct RawTrade {
    id: u64,
    buyer: AccountId,
    merchant: MerchantId,
    item: Item,
    quantity: u64,
    unit_price: u64,
    total: u64,
    listing_id: u64,
    settled_at_ns: u64,
    command_sequence: u64,
    event_sequence: u64,
}
impl RawTrade {
    fn view(&self) -> Value {
        json!({"trade_id":self.id.to_string(),"kind":"raw_purchase","buyer":{"kind":"player","account_id":self.buyer},"customer_pool_id":null,"seller":{"kind":"merchant","merchant_id":self.merchant},"item_id":self.item,"quantity":self.quantity.to_string(),"unit_price":self.unit_price.to_string(),"total_price":self.total.to_string(),"listing_id":self.listing_id.to_string(),"offer_id":null,"consumed_quantity":"0","settled_at_ns":self.settled_at_ns.to_string(),"command_principal":format!("account:{}",self.buyer),"command_sequence":self.command_sequence.to_string(),"event_sequence":self.event_sequence.to_string()})
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Purchase {
    trade: RawTrade,
    listing: Listing,
    buyer: Player,
    seller: Npc,
}
impl Purchase {
    pub(super) fn view(&self) -> Value {
        json!({"kind":"raw_purchased","trade":self.trade.view(),"listing":listing_view(self.trade.merchant.index(),self.trade.item,&self.listing),"buyer":self.buyer.ledger(),"seller":npc_ledger(self.trade.merchant.index(),&self.seller)})
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BuyArgs {
    merchant_id: MerchantId,
    item_id: Item,
    quantity: Decimal,
    expected_listing_revision: Decimal,
    max_total_price: Decimal,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ListingsArgs {
    shop_id: Option<Decimal>,
    item_id: Option<Item>,
    active_only: bool,
    after_id: Option<Decimal>,
    limit: Decimal,
    expected_market_revision: Decimal,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct TradeArgs {
    trade_id: Decimal,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct InventoryArgs {
    shop_id: Decimal,
}

// Validate promises on copies; no economic write precedes validation.
fn settle(
    buyer: &mut Player,
    seller: &mut Npc,
    slot: usize,
    quantity: u64,
    revision: u64,
    max: u64,
) -> Listing {
    require!((1..=100).contains(&quantity), "LT:E_INVALID_QUANTITY");
    require!((1..=10000).contains(&max), "LT:E_MAX_TOTAL");
    let mut listing = seller.listings[slot]
        .clone()
        .unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"));
    require!(listing.revision == revision, "LT:E_STALE_LISTING");
    let free_after_trade = seller.held.quantities[slot]
        .checked_sub(seller.reservations.trade.quantities[slot])
        .unwrap_or_else(|| env::panic_str("LT:E_INSUFFICIENT_AVAILABLE_STOCK"));
    require!(
        quantity <= listing.quantity
            && listing.quantity <= free_after_trade,
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK"
    );
    let total = quantity
        .checked_mul(listing.unit_price)
        .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
    require!(total <= 10000 && total <= max, "LT:E_MAX_TOTAL");
    require!(
        buyer
            .gold
            .checked_sub(buyer.reservations.gold_trade)
            .is_some_and(|v| v >= total),
        "LT:E_INSUFFICIENT_GOLD"
    );
    let new_item = buyer.inventory.quantities[slot]
        .checked_add(quantity)
        .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
    require!(
        new_item
            .checked_add(buyer.reservations.output.quantities[slot])
            .and_then(|v| v.checked_add(buyer.reservations.inbound.quantities[slot]))
            .is_some_and(|v| v <= 1000),
        "LT:E_BALANCE_CAP"
    );
    let seller_gold = seller
        .gold
        .checked_add(total)
        .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
    require!(
        seller_gold
            .checked_add(seller.reservations.gold_inbound)
            .is_some_and(|v| v <= 1_000_000),
        "LT:E_BALANCE_CAP"
    );
    // Check every revision before changing even the staged party copies.
    let buyer_revision = next(buyer.ledger_revision);
    let seller_revision = next(seller.ledger_revision);
    let listing_revision = next(listing.revision);
    buyer.gold -= total;
    buyer.inventory.quantities[slot] = new_item;
    buyer.ledger_revision = buyer_revision;
    seller.gold = seller_gold;
    seller.held.quantities[slot] -= quantity;
    seller.ledger_revision = seller_revision;
    listing.quantity -= quantity;
    listing.revision = listing_revision;
    seller.listings[slot] = Some(listing.clone());
    listing
}
#[near]
impl LivingTown {
    pub fn buy_from_merchant(
        &mut self,
        merchant_id: MerchantId,
        item_id: Item,
        quantity: Decimal,
        expected_listing_revision: Decimal,
        max_total_price: Decimal,
        command: Command,
    ) -> Value {
        let parsed: BuyArgs = args(&[
            "merchant_id",
            "item_id",
            "quantity",
            "expected_listing_revision",
            "max_total_price",
            "command",
        ]);
        require!(
            parsed.merchant_id == merchant_id
                && parsed.item_id == item_id
                && parsed.quantity == quantity
                && parsed.expected_listing_revision == expected_listing_revision
                && parsed.max_total_price == max_total_price
                && parsed.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = self.player_principal();
        require!(self.players.contains_key(&actor), "LT:E_NOT_REGISTERED");
        let (digest,replay)=self.command_check(&actor,"buy_from_merchant",json!({"merchant_id":merchant_id,"item_id":item_id,"quantity":quantity,"expected_listing_revision":expected_listing_revision,"max_total_price":max_total_price,"command":command}),&command);
        if let Some(value) = replay {
            return value;
        }
        let slot = item_id as usize;
        require!(slot < 4, "LT:E_INVALID_ARGUMENT");
        let index = merchant_id.index();
        let mut buyer = self.players.get(&actor).expect("registered").clone();
        let mut seller = self.npcs[index].clone();
        let listing = settle(
            &mut buyer,
            &mut seller,
            slot,
            quantity.0,
            expected_listing_revision.0,
            max_total_price.0,
        );
        let trade = RawTrade {
            id: self.next_trade_id,
            buyer: actor.clone(),
            merchant: merchant_id,
            item: item_id,
            quantity: quantity.0,
            unit_price: listing.unit_price,
            total: quantity
                .0
                .checked_mul(listing.unit_price)
                .expect("validated total"),
            listing_id: listing.id,
            settled_at_ns: env::block_timestamp(),
            command_sequence: command.sequence.0,
            event_sequence: next(self.market_revision),
        };
        self.next_trade_id = next(trade.id);
        self.trades.insert(trade.id, Trade::Raw(trade.clone()));
        if trade.id > 256 {
            self.trades.remove(&(trade.id - 256));
        }
        self.players.insert(actor.clone(), buyer.clone());
        self.npcs[index] = seller.clone();
        self.commit(
            actor,
            command,
            digest,
            Outcome::Purchased(Box::new(Purchase {
                trade,
                listing,
                buyer,
                seller,
            })),
        )
    }
    pub fn get_listings(
        &self,
        shop_id: Option<Decimal>,
        item_id: Option<Item>,
        active_only: bool,
        after_id: Option<Decimal>,
        limit: Decimal,
        expected_market_revision: Decimal,
    ) -> Value {
        let parsed: ListingsArgs = args(&[
            "shop_id",
            "item_id",
            "active_only",
            "after_id",
            "limit",
            "expected_market_revision",
        ]);
        require!(
            parsed.shop_id == shop_id
                && parsed.item_id == item_id
                && parsed.active_only == active_only
                && parsed.after_id == after_id
                && parsed.limit == limit
                && parsed.expected_market_revision == expected_market_revision,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        require!(shop_id.is_none_or(|id| id.0 > 0), "LT:E_INVALID_ARGUMENT");
        require!((1..=50).contains(&limit.0), "LT:E_INVALID_PAGE");
        require!(
            expected_market_revision.0 == self.market_revision,
            "LT:E_STALE_SNAPSHOT"
        );
        let mut rows = Vec::new();
        for id in 1..self.next_listing_id {
            if after_id.is_some_and(|after| id <= after.0) {
                continue;
            }
            if let Some((shop, item, listing)) = self.listing_row(id)
                && shop_id.is_none_or(|filter| filter.0 == shop)
                && item_id.is_none_or(|filter| filter == item)
                && (!active_only || listing.quantity > 0)
            {
                rows.push(super::listings::view(
                    shop,
                    item,
                    &listing,
                    &self.listing_owner(shop),
                ));
            }
        }
        rows.sort_by_key(|v| {
            v["listing_id"]
                .as_str()
                .expect("id")
                .parse::<u64>()
                .expect("integer")
        });
        let more = rows.len() > limit.0 as usize;
        rows.truncate(limit.0 as usize);
        let cursor = rows
            .last()
            .map(|r| r["listing_id"].clone())
            .unwrap_or_else(|| {
                after_id
                    .map(|id| json!(id.0.to_string()))
                    .unwrap_or(Value::Null)
            });
        self.snapshot(json!({"items":rows,"next_after_id":cursor,"has_more":more,"history_gap":false,"pruned_through":"0"}))
    }
    pub fn get_trade(&self, trade_id: Decimal) -> Value {
        let parsed: TradeArgs = args(&["trade_id"]);
        require!(
            parsed.trade_id == trade_id && trade_id.0 > 0,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        let result = if let Some(trade) = self.trades.get(&trade_id.0) {
            json!({"kind":"found","value":trade.view()})
        } else if trade_id.0 < self.next_trade_id {
            json!({"kind":"pruned","id":trade_id})
        } else {
            json!({"kind":"not_found","id":trade_id})
        };
        self.snapshot(result)
    }
    pub fn get_shop_inventory(&self, shop_id: Decimal) -> Value {
        let parsed: InventoryArgs = args(&["shop_id"]);
        require!(
            parsed.shop_id == shop_id && shop_id.0 > 0,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        let value = if shop_id.0 <= 3 {
            npc_ledger(shop_id.0 as usize - 1, &self.npcs[shop_id.0 as usize - 1])
        } else {
            let shop = self
                .shops
                .get(&shop_id.0)
                .unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"));
            self.players.get(&shop.owner).expect("shop ledger").ledger()
        };
        self.snapshot(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(predecessor: &str, payload: Value) {
        let mut ctx = near_sdk::test_utils::VMContextBuilder::new()
            .current_account_id("town.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .signer_account_id(predecessor.parse().unwrap())
            .account_balance(near_sdk::NearToken::from_near(1000))
            .block_timestamp(2)
            .build();
        ctx.input = serde_json::to_vec(&payload).unwrap().into();
        near_sdk::testing_env!(ctx);
    }
    #[test]
    fn trade_rollover_preserves_ids_high_water_and_latest_original_effect() {
        context("town.testnet", json!({}));
        let digest = config_digest();
        let controllers = Controllers {
            rex: "rex.testnet".parse().unwrap(),
            luna: "luna.testnet".parse().unwrap(),
            bolt: "bolt.testnet".parse().unwrap(),
        };
        context(
            "town.testnet",
            json!({"owner_account_id":"owner.testnet","operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest}),
        );
        let mut town = LivingTown::initialize_town(
            "owner.testnet".parse().unwrap(),
            controllers,
            "operator.testnet".parse().unwrap(),
            "11111111111111111111111111111111".to_owned(),
            digest,
        );
        let (mut player, _) = fixture();
        // Synthetic funding/restocking isolates ring rollover without implementing
        // the later supply methods or claiming this is an economic solvability run.
        player.gold = 1_000_000;
        town.players.insert(player.account_id.clone(), player);
        let mut last = Value::Null;
        for seq in 1..=257 {
            town.npcs[0].held.quantities[0] = 10;
            town.npcs[0].listings[0].as_mut().unwrap().quantity = 8;
            let revision = town.npcs[0].listings[0].as_ref().unwrap().revision;
            let command = Command {
                sequence: Decimal(seq),
                config_version: Decimal(1),
                valid_until_ns: Decimal(500_000_000_000),
            };
            let payload = json!({"merchant_id":"rex","item_id":"crystal","quantity":"1","expected_listing_revision":revision.to_string(),"max_total_price":"4","command":command});
            context("player.testnet", payload);
            last = town.buy_from_merchant(
                MerchantId::Rex,
                Item::Crystal,
                Decimal(1),
                Decimal(revision),
                Decimal(4),
                command,
            );
        }
        assert_eq!(town.next_trade_id, 258);
        assert!(town.trades.get(&1).is_none());
        assert!(town.trades.get(&2).is_some());
        assert!(town.trades.get(&257).is_some());
        let command = Command {
            sequence: Decimal(257),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        };
        context(
            "player.testnet",
            json!({"merchant_id":"rex","item_id":"crystal","quantity":"1","expected_listing_revision":"257","max_total_price":"4","command":command}),
        );
        let replay = town.buy_from_merchant(
            MerchantId::Rex,
            Item::Crystal,
            Decimal(1),
            Decimal(257),
            Decimal(4),
            command,
        );
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(replay["data"]["outcome"], last["data"]["outcome"]);
        assert_eq!(town.next_trade_id, 258);
        context(
            "player.testnet",
            json!({"principal":"account:player.testnet","sequence":"1"}),
        );
        let lookup = town.get_command("account:player.testnet".to_owned(), Decimal(1));
        assert_eq!(lookup["data"]["kind"], "pruned");
        assert_eq!(lookup["data"]["high_water"], "257");
        context("player.testnet", json!({"trade_id":"1"}));
        assert_eq!(town.get_trade(Decimal(1))["data"]["kind"], "pruned");
    }
    fn fixture() -> (Player, Npc) {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        (
            Player {
                account_id: "player.testnet".parse().unwrap(),
                gold: 100,
                inventory: Inventory::default(),
                ledger_revision: 1,
                shop_id: Some(4),
                grant_sequence: 1,
                reservations: Reservations::default(),
            },
            Npc {
                gold: 200,
                held: Inventory::new([10, 0, 0, 0, 0, 0]),
                listings: std::array::from_fn(|i| {
                    if i == 0 {
                        Some(Listing {
                            id: 1,
                            quantity: 8,
                            unit_price: 4,
                            revision: 1,
                        })
                    } else {
                        None
                    }
                }),
                ledger_revision: 1,
                production_revision: 1,
                reservations: Reservations::default(),
            },
        )
    }
    #[test]
    fn settlement_releases_listing_reservations_and_allows_selling_out() {
        let (mut buyer, mut seller) = fixture();
        seller.held.quantities[0] = 8;
        let listing = settle(&mut buyer, &mut seller, 0, 8, 1, 32);
        assert_eq!(listing.quantity, 0);
        assert_eq!(listing.revision, 2);
        assert_eq!(buyer.gold, 68);
        assert_eq!(seller.gold, 232);
        assert_eq!(seller.held.quantities[0], 0);
        assert_eq!(buyer.inventory.quantities[0], 8);
        assert_eq!(
            npc_ledger(0, &seller)["inventory"]["listing_reserved"]["crystal"],
            "0"
        );
        assert_eq!(
            npc_ledger(0, &seller)["inventory"]["available"]["crystal"],
            "0"
        );
    }
    #[test]
    fn promised_gold_and_items_cannot_be_spent_or_overfilled() {
        for case in 0..11 {
            let (mut buyer, mut seller) = fixture();
            match case {
                0 => buyer.reservations.gold_trade = 100,
                1 => buyer.reservations.output.quantities[0] = 1000,
                2 => buyer.reservations.inbound.quantities[0] = 1000,
                3 => seller.reservations.gold_inbound = 999_800,
                4 => seller.reservations.trade.quantities[0] = 3,
                5 => seller.held.quantities[0] = 0,
                6 => buyer.gold = 3,
                7 => buyer.inventory.quantities[0] = 1000,
                8 => {
                    buyer.inventory.quantities[0] = 999;
                    buyer.reservations.inbound.quantities[0] = 1;
                }
                9 => {
                    buyer.inventory.quantities[0] = 998;
                    buyer.reservations.inbound.quantities[0] = 1;
                    buyer.reservations.output.quantities[0] = 1;
                }
                _ => seller.listings[0].as_mut().unwrap().quantity = 0,
            }
            let before_buyer = near_sdk::borsh::to_vec(&buyer).unwrap();
            let before_seller = near_sdk::borsh::to_vec(&seller).unwrap();
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| settle(
                    &mut buyer,
                    &mut seller,
                    0,
                    1,
                    1,
                    4
                )))
                .is_err()
            );
            assert_eq!(near_sdk::borsh::to_vec(&buyer).unwrap(), before_buyer);
            assert_eq!(near_sdk::borsh::to_vec(&seller).unwrap(), before_seller);
        }
    }
    #[test]
    fn exact_item_cap_can_be_reached_without_using_promised_capacity() {
        let (mut buyer, mut seller) = fixture();
        buyer.inventory.quantities[0] = 999;
        settle(&mut buyer, &mut seller, 0, 1, 1, 4);
        assert_eq!(buyer.inventory.quantities[0], 1000);
        assert_eq!(buyer.gold, 96);
        assert_eq!(seller.held.quantities[0], 9);
        let before_buyer = near_sdk::borsh::to_vec(&buyer).unwrap();
        let before_seller = near_sdk::borsh::to_vec(&seller).unwrap();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| settle(
                &mut buyer,
                &mut seller,
                0,
                1,
                2,
                4
            )))
            .is_err()
        );
        assert_eq!(near_sdk::borsh::to_vec(&buyer).unwrap(), before_buyer);
        assert_eq!(near_sdk::borsh::to_vec(&seller).unwrap(), before_seller);
    }
    #[test]
    fn revision_overflow_rejects_before_mutating_either_settlement_party() {
        for case in 0..3 {
            let (mut buyer, mut seller) = fixture();
            match case {
                0 => buyer.ledger_revision = u64::MAX,
                1 => seller.ledger_revision = u64::MAX,
                _ => seller.listings[0].as_mut().unwrap().revision = u64::MAX,
            }
            let revision = seller.listings[0].as_ref().unwrap().revision;
            let before_buyer = near_sdk::borsh::to_vec(&buyer).unwrap();
            let before_seller = near_sdk::borsh::to_vec(&seller).unwrap();
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| settle(
                    &mut buyer,
                    &mut seller,
                    0,
                    1,
                    revision,
                    4
                )))
                .is_err()
            );
            assert_eq!(near_sdk::borsh::to_vec(&buyer).unwrap(), before_buyer);
            assert_eq!(near_sdk::borsh::to_vec(&seller).unwrap(), before_seller);
        }
    }
    #[test]
    fn invalid_purchase_quotes_preserve_both_parties_and_the_listing() {
        for (q, revision, max) in [
            (0, 1, 4),
            (101, 1, 404),
            (1, 2, 4),
            (1, 1, 0),
            (1, 1, 10001),
            (2, 1, 7),
        ] {
            let (mut buyer, mut seller) = fixture();
            let before_buyer = near_sdk::borsh::to_vec(&buyer).unwrap();
            let before_seller = near_sdk::borsh::to_vec(&seller).unwrap();
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| settle(
                    &mut buyer,
                    &mut seller,
                    0,
                    q,
                    revision,
                    max
                )))
                .is_err()
            );
            assert_eq!(near_sdk::borsh::to_vec(&buyer).unwrap(), before_buyer);
            assert_eq!(near_sdk::borsh::to_vec(&seller).unwrap(), before_seller);
        }
    }
    #[test]
    fn exact_item_and_gold_headroom_preserve_unrelated_promises_and_conservation() {
        let (mut buyer, mut seller) = fixture();
        buyer.inventory.quantities[0] = 998;
        buyer.reservations.inbound.quantities[0] = 1;
        buyer.reservations.gold_trade = 10;
        seller.gold = 999_995;
        seller.reservations.gold_inbound = 1;
        let total_gold = buyer.gold + seller.gold;
        let total_items = buyer.inventory.quantities[0] + seller.held.quantities[0];
        settle(&mut buyer, &mut seller, 0, 1, 1, 4);
        assert_eq!(
            buyer.inventory.quantities[0] + buyer.reservations.inbound.quantities[0],
            1000
        );
        assert_eq!(seller.gold + seller.reservations.gold_inbound, 1_000_000);
        assert_eq!(buyer.reservations.gold_trade, 10);
        assert_eq!(buyer.gold + seller.gold, total_gold);
        assert_eq!(
            buyer.inventory.quantities[0] + seller.held.quantities[0],
            total_items
        );
        // Release the independent incoming-item promise, isolating seller gold
        // headroom as the next purchase's rejection reason.
        buyer.reservations.inbound.quantities[0] = 0;
        let before_buyer = near_sdk::borsh::to_vec(&buyer).unwrap();
        let before_seller = near_sdk::borsh::to_vec(&seller).unwrap();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| settle(
                &mut buyer,
                &mut seller,
                0,
                1,
                2,
                4
            )))
            .is_err()
        );
        assert_eq!(near_sdk::borsh::to_vec(&buyer).unwrap(), before_buyer);
        assert_eq!(near_sdk::borsh::to_vec(&seller).unwrap(), before_seller);
    }
}
