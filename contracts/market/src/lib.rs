use near_sdk::{PanicOnDefault, near};

pub mod state;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    market: Option<state::MarketState>,
}

#[near]
impl Market {
    #[init]
    #[private]
    pub fn new() -> Self {
        Self { market: None }
    }

    pub fn get_name(&self) -> &'static str {
        "Bot Bazaar"
    }
}
