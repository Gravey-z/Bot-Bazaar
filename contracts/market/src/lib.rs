use near_sdk::{AccountId, PanicOnDefault, env, near, require};

mod acceptance;
mod actions;
mod admin;
mod cancellation;
mod cleanup;
mod events;
mod initialization;
mod listings;
mod proposals;
mod purchases;
mod registration;
pub mod state;
mod views;

pub use acceptance::SettlementResult;
pub use admin::PauseResult;
pub use cleanup::ExpireResult;
pub use listings::ListingResult;
pub use proposals::OfferResult;
pub use views::*;

pub use initialization::MerchantControllers;
use initialization::{initialized_state, parse_initialization_input};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    market: state::MarketState,
}

#[near]
impl Market {
    #[init]
    pub fn initialize_market(
        owner_account_id: AccountId,
        merchant_controllers: MerchantControllers,
    ) -> Self {
        let contract_account_id = env::current_account_id();
        require!(
            env::predecessor_account_id() == contract_account_id,
            "BB:E_UNAUTHORIZED"
        );
        let input = env::input().unwrap_or_else(|| env::panic_str("BB:E_INVALID_ARGUMENT"));
        let args = parse_initialization_input(&input)
            .unwrap_or_else(|| env::panic_str("BB:E_INVALID_ARGUMENT"));
        require!(
            args.owner_account_id == owner_account_id
                && args.merchant_controllers == merchant_controllers,
            "BB:E_INVALID_ARGUMENT"
        );
        let market =
            initialized_state(owner_account_id, merchant_controllers, &contract_account_id)
                .unwrap_or_else(|error| match error {
                    state::StateError::InvalidControllers => {
                        env::panic_str("BB:E_INVALID_CONTROLLERS")
                    }
                    _ => env::panic_str("BB:E_INVALID_ARGUMENT:invalid fixed seed"),
                });
        let contract = Self { market };
        events::emit("initialize_market", &contract.market_snapshot());
        contract
    }
}
