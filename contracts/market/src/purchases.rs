use crate::{
    Decimal, Market, MarketExt, Snapshot, TradeView,
    state::{
        Actor, MAX_QUANTITY, MAX_TOTAL_PRICE, MerchantId, Resource, StateError, Trade, TradeKind,
        checked_increment, checked_trade_total,
    },
    views::input::validate_input,
};
use near_sdk::{env, near, require};

pub(crate) fn balance_failure(error: StateError, insufficient: &str) -> ! {
    match error {
        StateError::InsufficientBalance => env::panic_str(insufficient),
        StateError::LimitExceeded => env::panic_str("BB:E_BALANCE_CAP"),
        StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
        _ => env::panic_str("BB:E_INVALID_ARGUMENT:invalid balance"),
    }
}

#[near]
impl Market {
    pub fn buy_from_merchant(
        &mut self,
        merchant_id: MerchantId,
        resource: Resource,
        quantity: Decimal,
        max_total_price: Decimal,
        listing_version: Decimal,
    ) -> Snapshot<TradeView> {
        validate_input(&[
            "merchant_id",
            "resource",
            "quantity",
            "max_total_price",
            "listing_version",
        ]);
        require!(!self.market.paused, "BB:E_MARKET_PAUSED");
        let account_id = env::predecessor_account_id();
        let player = self
            .market
            .players
            .get(&account_id)
            .unwrap_or_else(|| env::panic_str("BB:E_NOT_REGISTERED"));
        require!(
            (1..=MAX_QUANTITY).contains(&quantity.0),
            "BB:E_INVALID_QUANTITY"
        );
        require!(
            (1..=MAX_TOTAL_PRICE).contains(&max_total_price.0),
            "BB:E_INVALID_TOTAL"
        );
        let merchant = &self.market.merchants[merchant_id.index()];
        let mut listing = merchant.listings[resource.index()];
        require!(listing.version == listing_version.0, "BB:E_STALE_LISTING");
        require!(listing.active, "BB:E_LISTING_INACTIVE");
        require!(
            quantity.0 <= listing.quantity,
            "BB:E_INSUFFICIENT_LISTED_QUANTITY"
        );
        require!(
            quantity.0 <= merchant.balances.inventory.amount(resource),
            "BB:E_INSUFFICIENT_STOCK"
        );
        let total =
            checked_trade_total(quantity.0, listing.unit_price).unwrap_or_else(
                |error| match error {
                    StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
                    _ => env::panic_str("BB:E_INVALID_TOTAL"),
                },
            );
        require!(total <= max_total_price.0, "BB:E_INVALID_TOTAL");
        let mut buyer = player.balances;
        let mut seller = merchant.balances;
        buyer
            .debit_gold(total)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_GOLD"));
        buyer
            .inventory
            .credit(resource, quantity.0)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        seller
            .credit_gold(total)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_GOLD"));
        seller
            .inventory
            .debit(resource, quantity.0)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        listing = listing
            .after_purchase(quantity.0, merchant.balances.inventory.amount(resource))
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_LISTED_QUANTITY"));
        let revision = checked_increment(self.market.market_revision)
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        let trade = Trade {
            trade_id: self.market.trade_ids.next_id(),
            kind: TradeKind::PlayerPurchase,
            buyer: Actor::Player {
                account_id: account_id.clone(),
            },
            seller: Actor::Merchant { merchant_id },
            resource,
            quantity: quantity.0,
            unit_price: listing.unit_price,
            total_price: total,
            offer_id: None,
            buyer_gold_after: buyer.gold(),
            seller_gold_after: seller.gold(),
            buyer_resource_after: buyer.inventory.amount(resource),
            seller_resource_after: seller.inventory.amount(resource),
            settled_at_ns: env::block_timestamp(),
            market_revision: revision,
        };
        let result = (&trade).into();
        self.market
            .append_trade(trade)
            .unwrap_or_else(|error| match error {
                StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
                _ => env::panic_str("BB:E_INVALID_ARGUMENT:invalid trade storage"),
            });
        self.market
            .players
            .get_mut(&account_id)
            .expect("registered buyer exists")
            .balances = buyer;
        let merchant = &mut self.market.merchants[merchant_id.index()];
        merchant.balances = seller;
        merchant.listings[resource.index()] = listing;
        self.market.market_revision = revision;
        self.snapshot(result)
    }
}

#[cfg(test)]
mod tests;
