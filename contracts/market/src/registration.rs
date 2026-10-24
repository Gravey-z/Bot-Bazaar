use crate::{
    Market, MarketExt, PlayerView, Snapshot,
    state::{StateError, checked_increment},
    views::input::validate_input,
};
use near_sdk::{env, near, require};

#[near]
impl Market {
    pub fn register_player(&mut self) -> Snapshot<PlayerView> {
        validate_input(&[]);
        let account_id = env::predecessor_account_id();
        require!(
            account_id != env::current_account_id()
                && account_id != self.market.owner_account_id
                && self
                    .market
                    .merchants
                    .iter()
                    .all(|merchant| merchant.controller_account_id != account_id),
            "BB:E_RESERVED_ACCOUNT"
        );
        let revision = checked_increment(self.market.market_revision)
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        self.market
            .add_player(account_id.clone())
            .unwrap_or_else(|error| match error {
                StateError::MarketPaused => env::panic_str("BB:E_MARKET_PAUSED"),
                StateError::AlreadyRegistered => env::panic_str("BB:E_ALREADY_REGISTERED"),
                StateError::PlayerCapacity => env::panic_str("BB:E_PLAYER_CAPACITY"),
                StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
                _ => env::panic_str("BB:E_INVALID_ARGUMENT:invalid player grant"),
            });
        self.market.market_revision = revision;
        let player = self
            .market
            .players
            .get(&account_id)
            .expect("registered player exists");
        self.snapshot(player.into())
    }
}

#[cfg(test)]
mod tests;
