use super::tests::{context, initialize};
use super::*;
use near_sdk::{NearToken, test_utils::VMContextBuilder, testing_env};

#[test]
fn final_registration_slot_admits_once_and_rejection_keeps_all_markers() {
    let mut town = initialize();
    // Counter-boundary fixture, not a claim that 999 accounts were populated
    // or that full-capacity native storage funding was measured.
    town.registered_player_count = 999;
    town.issued_grants = 99_900;
    let command = Command {
        sequence: Decimal(1),
        config_version: Decimal(1),
        valid_until_ns: Decimal(500_000_000_000),
    };
    context("last.testnet", json!({"command":command}), 2);
    town.register_player(command.clone());
    assert_eq!(town.registered_player_count, 1000);
    assert_eq!(town.issued_grants, 100_000);
    let before = near_sdk::borsh::to_vec(&town).unwrap();
    context("overflow.testnet", json!({"command":command}), 3);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || town.register_player(command)
        ))
        .is_err()
    );
    assert_eq!(near_sdk::borsh::to_vec(&town).unwrap(), before);
    assert!(
        !town
            .players
            .contains_key(&"overflow.testnet".parse::<AccountId>().unwrap())
    );
    assert!(
        !town
            .commands
            .contains_key(&"overflow.testnet".parse::<AccountId>().unwrap())
    );
}
#[test]
fn signer_cannot_replace_predecessor_for_grant_shop_or_rename_authority() {
    let mut town = initialize();
    let command = Command {
        sequence: Decimal(1),
        config_version: Decimal(1),
        valid_until_ns: Decimal(500_000_000_000),
    };
    let mut ctx = VMContextBuilder::new()
        .current_account_id("town.testnet".parse().unwrap())
        .predecessor_account_id("relay.testnet".parse().unwrap())
        .signer_account_id("victim.testnet".parse().unwrap())
        .account_balance(NearToken::from_near(1000))
        .block_timestamp(2)
        .build();
    ctx.input = serde_json::to_vec(&json!({"command":command}))
        .unwrap()
        .into();
    testing_env!(ctx);
    town.register_player(command);
    assert!(
        !town
            .players
            .contains_key(&"victim.testnet".parse::<AccountId>().unwrap())
    );
    assert_eq!(
        town.players
            .get(&"relay.testnet".parse::<AccountId>().unwrap())
            .unwrap()
            .gold,
        100
    );
    let command = Command {
        sequence: Decimal(2),
        config_version: Decimal(1),
        valid_until_ns: Decimal(500_000_000_000),
    };
    context(
        "relay.testnet",
        json!({"name":"Relay Shop","command":command}),
        3,
    );
    town.create_shop("Relay Shop".to_owned(), command);
    let before = near_sdk::borsh::to_vec(&town).unwrap();
    let command = Command {
        sequence: Decimal(1),
        config_version: Decimal(1),
        valid_until_ns: Decimal(500_000_000_000),
    };
    context(
        "victim.testnet",
        json!({"shop_id":"4","expected_shop_revision":"1","name":"Stolen Shop","command":command}),
        4,
    );
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| town.rename_shop(
            Decimal(4),
            Decimal(1),
            "Stolen Shop".to_owned(),
            command
        )))
        .is_err()
    );
    assert_eq!(near_sdk::borsh::to_vec(&town).unwrap(), before);
    assert_eq!(town.shops.get(&4).unwrap().owner.as_str(), "relay.testnet");
}
