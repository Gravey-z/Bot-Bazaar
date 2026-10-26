use crate::{
    Decimal, Market, MarketExt, OfferResult, OfferView, Snapshot,
    listings::canonical_json,
    state::{LastAction, MerchantMethod, OfferStatus, checked_increment},
    views::input::validate_input,
};
use near_sdk::{env, json_types::U64, near, require, serde_json::json};

#[near]
impl Market {
    pub fn cancel_trade(&mut self, offer_id: Decimal, action_id: Decimal) -> Snapshot<OfferResult> {
        validate_input(&["offer_id", "action_id"]);
        require!(offer_id.0 > 0, "BB:E_INVALID_ARGUMENT");
        let offer = self.market.offers.get(&offer_id.0).unwrap_or_else(|| {
            if offer_id.0 < self.market.offer_ids.next_id() {
                env::panic_str("BB:E_OFFER_PRUNED")
            } else {
                env::panic_str("BB:E_OFFER_NOT_FOUND")
            }
        });
        let proposer = offer.proposer;
        let merchant = &self.market.merchants[proposer.index()];
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
        require!(
            action_id.0 > merchant.actions.last_action_id(),
            "BB:E_ACTION_USED"
        );
        let next_action = merchant
            .actions
            .next_action_id()
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        require!(action_id.0 == next_action, "BB:E_ACTION_GAP");
        let revision = checked_increment(self.market.market_revision)
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        let canonical = canonical_json(
            &json!({"method":"cancel_trade","args":{"offer_id":offer_id,"action_id":action_id}}),
        );
        let action = LastAction {
            action_id: action_id.0,
            method: MerchantMethod::CancelTrade,
            args_sha256: env::sha256_array(canonical.as_bytes()),
            market_revision: revision,
            offer_id: Some(offer_id.0),
            trade_id: None,
            listing_version: None,
        };
        let mut offer_view = OfferView::at(offer, now);
        offer_view.status = OfferStatus::Cancelled;
        offer_view.closed_at_ns = Some(U64(now));
        let result = OfferResult {
            offer: offer_view,
            action: (&action).into(),
        };
        self.market
            .close_offer(offer_id.0, OfferStatus::Cancelled, now, None)
            .unwrap_or_else(|_| env::panic_str("BB:E_INVALID_ARGUMENT:invalid offer storage"));
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
