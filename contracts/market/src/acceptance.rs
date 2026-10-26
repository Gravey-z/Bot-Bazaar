use crate::{
    Decimal, LastActionView, Market, MarketExt, OfferView, Snapshot, TradeView,
    listings::canonical_json,
    purchases::balance_failure,
    state::{
        Actor, LastAction, MerchantMethod, OfferStatus, StateError, Trade, TradeKind,
        checked_increment, checked_trade_total,
    },
    views::input::validate_input,
};
use near_sdk::{env, json_types::U64, near, require, serde_json::json};

#[near(serializers = [json])]
pub struct SettlementResult {
    pub offer: OfferView,
    pub trade: TradeView,
    pub action: LastActionView,
}

fn storage_failure(error: StateError) -> ! {
    match error {
        StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
        _ => env::panic_str("BB:E_INVALID_ARGUMENT:invalid settlement storage"),
    }
}

#[near]
impl Market {
    pub fn accept_trade(
        &mut self,
        offer_id: Decimal,
        action_id: Decimal,
    ) -> Snapshot<SettlementResult> {
        validate_input(&["offer_id", "action_id"]);
        require!(!self.market.paused, "BB:E_MARKET_PAUSED");
        require!(offer_id.0 > 0, "BB:E_INVALID_ARGUMENT");
        let offer = self.market.offers.get(&offer_id.0).unwrap_or_else(|| {
            if offer_id.0 < self.market.offer_ids.next_id() {
                env::panic_str("BB:E_OFFER_PRUNED")
            } else {
                env::panic_str("BB:E_OFFER_NOT_FOUND")
            }
        });
        let counterparty = offer.counterparty;
        let merchant = &self.market.merchants[counterparty.index()];
        require!(
            env::predecessor_account_id() == merchant.controller_account_id,
            "BB:E_UNAUTHORIZED"
        );
        match offer.status {
            OfferStatus::Accepted => env::panic_str("BB:E_OFFER_ACCEPTED"),
            OfferStatus::Cancelled => env::panic_str("BB:E_OFFER_CANCELLED"),
            OfferStatus::Expired => env::panic_str("BB:E_OFFER_EXPIRED"),
            OfferStatus::Pending => (),
        }
        let now = env::block_timestamp();
        require!(now < offer.expires_at_ns, "BB:E_OFFER_EXPIRED");
        crate::actions::validate_action(&merchant.actions, action_id.0);
        require!(
            offer.buyer != offer.seller
                && [offer.buyer, offer.seller].contains(&offer.proposer)
                && counterparty
                    == if offer.proposer == offer.buyer {
                        offer.seller
                    } else {
                        offer.buyer
                    },
            "BB:E_INVALID_ROLES"
        );
        let total =
            checked_trade_total(offer.quantity, offer.unit_price).unwrap_or_else(
                |error| match error {
                    StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
                    _ => env::panic_str("BB:E_INVALID_TOTAL"),
                },
            );
        require!(total == offer.total_price, "BB:E_INVALID_TOTAL");
        let buyer_id = offer.buyer;
        let seller_id = offer.seller;
        let resource = offer.resource;
        let buyer_merchant = &self.market.merchants[buyer_id.index()];
        let seller_merchant = &self.market.merchants[seller_id.index()];
        let mut buyer = buyer_merchant.balances;
        let mut seller = seller_merchant.balances;
        buyer
            .debit_gold(total)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_GOLD"));
        buyer
            .inventory
            .credit(resource, offer.quantity)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        seller
            .inventory
            .debit(resource, offer.quantity)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        seller
            .credit_gold(total)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_GOLD"));
        let buyer_listing = buyer_merchant.listings[resource.index()]
            .after_stock_change(
                buyer_merchant.balances.inventory.amount(resource),
                buyer.inventory.amount(resource),
            )
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        let seller_listing = seller_merchant.listings[resource.index()]
            .after_stock_change(
                seller_merchant.balances.inventory.amount(resource),
                seller.inventory.amount(resource),
            )
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        let revision = checked_increment(self.market.market_revision)
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        let trade_id = self.market.trade_ids.next_id();
        let trade = Trade {
            trade_id,
            kind: TradeKind::MerchantTrade,
            buyer: Actor::Merchant {
                merchant_id: buyer_id,
            },
            seller: Actor::Merchant {
                merchant_id: seller_id,
            },
            resource,
            quantity: offer.quantity,
            unit_price: offer.unit_price,
            total_price: total,
            offer_id: Some(offer_id.0),
            buyer_gold_after: buyer.gold(),
            seller_gold_after: seller.gold(),
            buyer_resource_after: buyer.inventory.amount(resource),
            seller_resource_after: seller.inventory.amount(resource),
            settled_at_ns: now,
            market_revision: revision,
        };
        let canonical = canonical_json(
            &json!({"method":"accept_trade","args":{"offer_id":offer_id,"action_id":action_id}}),
        );
        let action = LastAction {
            action_id: action_id.0,
            method: MerchantMethod::AcceptTrade,
            args_sha256: env::sha256_array(canonical.as_bytes()),
            market_revision: revision,
            offer_id: Some(offer_id.0),
            trade_id: Some(trade_id),
            listing_version: None,
        };
        let mut offer_view = OfferView::at(offer, now);
        offer_view.status = OfferStatus::Accepted;
        offer_view.closed_at_ns = Some(U64(now));
        offer_view.settled_trade_id = Some(U64(trade_id));
        let result = SettlementResult {
            offer: offer_view,
            trade: (&trade).into(),
            action: (&action).into(),
        };
        self.market
            .validate_trade_append(&trade)
            .unwrap_or_else(|error| storage_failure(error));
        self.market
            .close_offer(offer_id.0, OfferStatus::Accepted, now, Some(trade_id))
            .unwrap_or_else(|error| storage_failure(error));
        self.market
            .append_trade(trade)
            .unwrap_or_else(|error| storage_failure(error));
        self.market.merchants[buyer_id.index()].balances = buyer;
        self.market.merchants[buyer_id.index()].listings[resource.index()] = buyer_listing;
        self.market.merchants[seller_id.index()].balances = seller;
        self.market.merchants[seller_id.index()].listings[resource.index()] = seller_listing;
        self.market.merchants[counterparty.index()]
            .actions
            .record(action)
            .unwrap_or_else(|_| env::panic_str("BB:E_INVALID_ARGUMENT:invalid action sequence"));
        self.market.market_revision = revision;
        self.snapshot(result)
    }
}

#[cfg(test)]
mod tests;
