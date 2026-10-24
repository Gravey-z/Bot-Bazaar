use crate::{Market, MarketExt, Snapshot, state::checked_increment, views::input::validate_input};
use near_sdk::{env, near, require};

#[near(serializers = [json])]
pub struct PauseResult {
    pub paused: bool,
    pub changed: bool,
}

impl Market {
    fn set_paused(&mut self, paused: bool) -> Snapshot<PauseResult> {
        validate_input(&[]);
        require!(
            env::predecessor_account_id() == self.market.owner_account_id,
            "BB:E_UNAUTHORIZED"
        );
        let changed = self.market.paused != paused;
        if changed {
            let revision = checked_increment(self.market.market_revision)
                .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
            self.market.paused = paused;
            self.market.market_revision = revision;
        }
        self.snapshot(PauseResult { paused, changed })
    }
}

#[near]
impl Market {
    pub fn pause_market(&mut self) -> Snapshot<PauseResult> {
        self.set_paused(true)
    }

    pub fn resume_market(&mut self) -> Snapshot<PauseResult> {
        self.set_paused(false)
    }
}

#[cfg(test)]
mod tests;
