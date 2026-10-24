use super::*;
use crate::{MerchantControllers, initialization::initialized_state, state::Resource};
use near_sdk::{
    borsh,
    serde_json::{self, json},
    test_utils::VMContextBuilder,
    testing_env,
};

fn context(predecessor: &str, signer: &str) {
    let mut context = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id(signer.parse().unwrap())
        .block_height(42)
        .block_timestamp(100)
        .build();
    context.input = b"{}".to_vec().into();
    testing_env!(context);
}

fn market() -> Market {
    context("player.testnet", "player.testnet");
    Market {
        market: initialized_state(
            "owner.testnet".parse().unwrap(),
            MerchantControllers {
                rex: "rex.testnet".parse().unwrap(),
                luna: "luna.testnet".parse().unwrap(),
                bolt: "bolt.testnet".parse().unwrap(),
            },
            &"market.testnet".parse().unwrap(),
        )
        .unwrap(),
    }
}

fn rejects_without_changes(market: &mut Market, code: &str) {
    let before = borsh::to_vec(&market.market).unwrap();
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| market.register_player()))
        .err()
        .unwrap();
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(message.contains(code), "{message}");
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
}

#[test]
fn registration_grants_exactly_once_and_preserves_the_economy_seed() {
    let mut market = market();
    let before: Vec<_> = market
        .market
        .merchants
        .iter()
        .map(|merchant| borsh::to_vec(merchant).unwrap())
        .collect();
    let result = market.register_player();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({
            "market_revision":"2","block_height":"42","block_timestamp_ns":"100",
            "data":{"account_id":"player.testnet","gold":"100","inventory":{"crystal":"0","wood":"0","herb":"0","iron":"0"}}
        })
    );
    assert_eq!(market.market.registered_player_count, 1);
    assert_eq!(market.market.total_issued_gold, 650);
    for resource in Resource::ALL {
        assert_eq!(
            market.market.resource_supply.amount(resource),
            [29, 25, 26, 24][resource.index()]
        );
    }
    for (merchant, bytes) in market.market.merchants.iter().zip(before) {
        assert_eq!(borsh::to_vec(merchant).unwrap(), bytes);
    }
    rejects_without_changes(&mut market, "BB:E_ALREADY_REGISTERED");
    assert_eq!(
        market
            .market
            .players
            .get(&"player.testnet".parse::<near_sdk::AccountId>().unwrap())
            .unwrap()
            .balances
            .gold(),
        100
    );
}

#[test]
fn registration_uses_predecessor_independently_of_signer() {
    let mut market = market();
    context("proxy.testnet", "owner.testnet");
    let result = market.register_player();
    assert_eq!(result.data.account_id.as_str(), "proxy.testnet");
    assert!(
        market
            .market
            .players
            .get(&"owner.testnet".parse::<near_sdk::AccountId>().unwrap())
            .is_none()
    );
    context("player.testnet", "player.testnet");
    market.register_player();
    assert_eq!(market.market.registered_player_count, 2);
    assert_eq!(market.market.total_issued_gold, 750);
    assert_eq!(market.market.market_revision, 3);
}

#[test]
fn infrastructure_accounts_are_reserved_without_allocating_player_records() {
    let mut market = market();
    for id in [
        "market.testnet",
        "owner.testnet",
        "rex.testnet",
        "luna.testnet",
        "bolt.testnet",
    ] {
        context(id, id);
        rejects_without_changes(&mut market, "BB:E_RESERVED_ACCOUNT");
        assert!(
            market
                .market
                .players
                .get(&id.parse::<near_sdk::AccountId>().unwrap())
                .is_none()
        );
    }
}

#[test]
fn paused_capacity_and_overflow_fail_before_granting_assets() {
    let mut market = market();
    market.market.paused = true;
    rejects_without_changes(&mut market, "BB:E_MARKET_PAUSED");
    market.market.paused = false;
    market.market.registered_player_count = 1000;
    rejects_without_changes(&mut market, "BB:E_PLAYER_CAPACITY");
    market.market.registered_player_count = 0;
    market.market.market_revision = u64::MAX;
    rejects_without_changes(&mut market, "BB:E_ARITHMETIC_OVERFLOW");
    market.market.market_revision = 1;
    market.market.total_issued_gold = u64::MAX;
    rejects_without_changes(&mut market, "BB:E_ARITHMETIC_OVERFLOW");
    assert!(
        market
            .market
            .players
            .get(&"player.testnet".parse::<near_sdk::AccountId>().unwrap())
            .is_none()
    );
}
