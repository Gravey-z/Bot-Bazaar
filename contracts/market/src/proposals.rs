use crate::{
    Decimal, LastActionView, Market, MarketExt, OfferView, Snapshot,
    listings::canonical_json,
    purchases::balance_failure,
    state::{
        ActionRef, LastAction, MAX_OFFER_LIFETIME_NS, MAX_QUANTITY, MAX_TOTAL_PRICE,
        MAX_UNIT_PRICE, MerchantId, MerchantMethod, Offer, OfferStatus, Resource, StateError,
        checked_increment,
    },
    views::input::validate_input,
};
use near_sdk::{env, near, require, serde_json::json};

#[near(serializers = [json])]
pub struct OfferResult {
    pub offer: OfferView,
    pub action: LastActionView,
}

#[near]
impl Market {
    #[allow(clippy::too_many_arguments)]
    pub fn propose_trade(
        &mut self,
        proposer: MerchantId,
        buyer: MerchantId,
        seller: MerchantId,
        resource: Resource,
        quantity: Decimal,
        total_price: Decimal,
        expires_at_ns: Decimal,
        action_id: Decimal,
    ) -> Snapshot<OfferResult> {
        validate_input(&[
            "proposer",
            "buyer",
            "seller",
            "resource",
            "quantity",
            "total_price",
            "expires_at_ns",
            "action_id",
        ]);
        let merchant = &self.market.merchants[proposer.index()];
        require!(
            env::predecessor_account_id() == merchant.controller_account_id,
            "BB:E_UNAUTHORIZED"
        );
        require!(!self.market.paused, "BB:E_MARKET_PAUSED");
        require!(
            buyer != seller && [buyer, seller].contains(&proposer),
            "BB:E_INVALID_ROLES"
        );
        crate::actions::validate_action(&merchant.actions, action_id.0);
        require!(
            (1..=MAX_QUANTITY).contains(&quantity.0),
            "BB:E_INVALID_QUANTITY"
        );
        require!(
            (1..=MAX_TOTAL_PRICE).contains(&total_price.0),
            "BB:E_INVALID_TOTAL"
        );
        require!(
            total_price.0.is_multiple_of(quantity.0),
            "BB:E_NON_INTEGER_UNIT_PRICE"
        );
        let unit_price = total_price.0 / quantity.0;
        require!(
            (1..=MAX_UNIT_PRICE).contains(&unit_price),
            "BB:E_INVALID_PRICE"
        );
        let now = env::block_timestamp();
        let latest_expiry = now
            .checked_add(MAX_OFFER_LIFETIME_NS)
            .unwrap_or_else(|| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        require!(
            now < expires_at_ns.0 && expires_at_ns.0 <= latest_expiry,
            "BB:E_INVALID_EXPIRY"
        );
        let mut buyer_balances = self.market.merchants[buyer.index()].balances;
        let mut seller_balances = self.market.merchants[seller.index()].balances;
        buyer_balances
            .debit_gold(total_price.0)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_GOLD"));
        buyer_balances
            .inventory
            .credit(resource, quantity.0)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        seller_balances
            .inventory
            .debit(resource, quantity.0)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_STOCK"));
        seller_balances
            .credit_gold(total_price.0)
            .unwrap_or_else(|error| balance_failure(error, "BB:E_INSUFFICIENT_GOLD"));
        let revision = checked_increment(self.market.market_revision)
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        let offer_id = self.market.offer_ids.next_id();
        let offer = Offer {
            offer_id,
            proposer,
            buyer,
            seller,
            counterparty: if proposer == buyer { seller } else { buyer },
            resource,
            quantity: quantity.0,
            unit_price,
            total_price: total_price.0,
            created_at_ns: now,
            expires_at_ns: expires_at_ns.0,
            status: OfferStatus::Pending,
            closed_at_ns: None,
            settled_trade_id: None,
            proposal_action: ActionRef {
                merchant_id: proposer,
                action_id: action_id.0,
            },
        };
        let canonical = canonical_json(&json!({"method":"propose_trade","args":{
            "proposer":proposer,"buyer":buyer,"seller":seller,"resource":resource,
            "quantity":quantity,"total_price":total_price,"expires_at_ns":expires_at_ns,"action_id":action_id
        }}));
        let action = LastAction {
            action_id: action_id.0,
            method: MerchantMethod::ProposeTrade,
            args_sha256: env::sha256_array(canonical.as_bytes()),
            market_revision: revision,
            offer_id: Some(offer_id),
            trade_id: None,
            listing_version: None,
        };
        let result = OfferResult {
            offer: OfferView::at(&offer, now),
            action: (&action).into(),
        };
        self.market
            .insert_pending_offer(offer)
            .unwrap_or_else(|error| match error {
                StateError::OfferCapacity => env::panic_str("BB:E_OFFER_CAPACITY"),
                StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
                _ => env::panic_str("BB:E_INVALID_ARGUMENT:invalid offer storage"),
            });
        self.market.merchants[proposer.index()]
            .actions
            .record(action)
            .unwrap_or_else(|_| env::panic_str("BB:E_INVALID_ARGUMENT:invalid action sequence"));
        self.market.market_revision = revision;
        self.snapshot(result)
    }
}

#[cfg(test)]
mod tests;
