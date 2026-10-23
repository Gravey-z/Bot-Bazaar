use near_sdk::{PanicOnDefault, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {}

#[near]
impl Market {
    #[init]
    #[private]
    pub fn new() -> Self {
        Self {}
    }

    pub fn get_name(&self) -> &'static str {
        "Bot Bazaar"
    }
}
