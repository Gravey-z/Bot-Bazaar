use crate::{
    Decimal, Market, MarketExt, Snapshot, state::StateError, views::input::validate_input,
};
use near_sdk::{env, json_types::U64, near};

#[near(serializers = [json])]
pub struct ExpireResult {
    pub expired_offer_ids: Vec<U64>,
    pub ignored_offer_ids: Vec<U64>,
}

#[near]
impl Market {
    pub fn expire_offers(&mut self, offer_ids: Vec<Decimal>) -> Snapshot<ExpireResult> {
        validate_input(&["offer_ids"]);
        let ids: Vec<_> = offer_ids.into_iter().map(|id| id.0).collect();
        let (expired, ignored) = self
            .market
            .expire_offers(&ids, env::block_timestamp())
            .unwrap_or_else(|error| match error {
                StateError::InvalidBatch => env::panic_str("BB:E_INVALID_BATCH"),
                StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
                _ => env::panic_str("BB:E_INVALID_ARGUMENT:inconsistent offer storage"),
            });
        self.snapshot(ExpireResult {
            expired_offer_ids: expired.into_iter().map(U64).collect(),
            ignored_offer_ids: ignored.into_iter().map(U64).collect(),
        })
    }
}
