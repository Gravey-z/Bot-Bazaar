use super::*;
use crate::{MerchantControllers, initialization::initialized_state};
use near_sdk::{borsh, test_utils::VMContextBuilder, testing_env};

fn context(predecessor: &str, args: &Value) {
    let mut context = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id("rex.testnet".parse().unwrap())
        .build();
    context.input = serde_json::to_vec(args).unwrap().into();
    testing_env!(context);
}

fn market() -> Market {
    context("rex.testnet", &serde_json::json!({}));
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

fn args() -> Value {
    serde_json::json!({"merchant_id":"rex","resource":"crystal","unit_price":"7","quantity":"7","active":true,"expected_version":"1","action_id":"1"})
}

fn update(market: &mut Market, args: &Value) -> Snapshot<ListingResult> {
    market.set_listing(
        serde_json::from_value(args["merchant_id"].clone()).unwrap(),
        serde_json::from_value(args["resource"].clone()).unwrap(),
        serde_json::from_value(args["unit_price"].clone()).unwrap(),
        serde_json::from_value(args["quantity"].clone()).unwrap(),
        args["active"].as_bool().unwrap(),
        serde_json::from_value(args["expected_version"].clone()).unwrap(),
        serde_json::from_value(args["action_id"].clone()).unwrap(),
    )
}

fn reject(market: &mut Market, args: &Value, code: &str) {
    let before = borsh::to_vec(&market.market).unwrap();
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| update(market, args)))
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
fn listing_update_records_exact_digest_versions_and_no_asset_movement() {
    let mut market = market();
    let args = args();
    context("rex.testnet", &args);
    let balances: Vec<_> = market.market.merchants.iter().map(|m| m.balances).collect();
    let supply = market.market.resource_supply;
    let result = serde_json::to_value(update(&mut market, &args)).unwrap();
    assert_eq!(result["market_revision"], "2");
    assert_eq!(
        result["data"]["listing"],
        serde_json::json!({"merchant_id":"rex","resource":"crystal","unit_price":"7","quantity":"7","active":true,"version":"2"})
    );
    assert_eq!(
        result["data"]["action"],
        serde_json::json!({
            "action_id":"1","method":"set_listing","args_sha256":"3fce6ebef844b51a9bf3c3a6845c258dea2edc92ba36671dcbdcd2d650fc7390",
            "market_revision":"2","offer_id":null,"trade_id":null,"listing_version":"2"
        })
    );
    assert_eq!(
        market
            .market
            .merchants
            .iter()
            .map(|m| m.balances)
            .collect::<Vec<_>>(),
        balances
    );
    assert_eq!(market.market.resource_supply, supply);
    assert_eq!(market.market.total_issued_gold, 550);
    assert_eq!(market.market.offer_ids.next_id(), 1);
    assert_eq!(market.market.trade_ids.next_id(), 1);
}

#[test]
fn invalid_updates_preserve_state_and_allow_corrected_action_reuse() {
    let mut market = market();
    for (field, value, code) in [
        ("unit_price", "0", "BB:E_INVALID_PRICE"),
        ("unit_price", "101", "BB:E_INVALID_PRICE"),
        ("quantity", "0", "BB:E_INVALID_QUANTITY"),
        ("quantity", "101", "BB:E_INVALID_QUANTITY"),
        ("quantity", "16", "BB:E_INSUFFICIENT_STOCK"),
        ("expected_version", "0", "BB:E_STALE_LISTING"),
        ("action_id", "0", "BB:E_ACTION_USED"),
        ("action_id", "2", "BB:E_ACTION_GAP"),
    ] {
        let mut args = args();
        args[field] = Value::String(value.to_owned());
        context("rex.testnet", &args);
        reject(&mut market, &args, code);
    }
    let mut same = args();
    same["unit_price"] = serde_json::json!("4");
    same["quantity"] = serde_json::json!("15");
    context("rex.testnet", &same);
    reject(&mut market, &same, "BB:E_NO_CHANGE");
    let mut invalid = args();
    invalid["active"] = serde_json::json!(false);
    context("rex.testnet", &invalid);
    reject(&mut market, &invalid, "BB:E_INVALID_QUANTITY");
    let args = args();
    context("rex.testnet", &args);
    update(&mut market, &args);
    let mut reused = args.clone();
    reused["expected_version"] = serde_json::json!("2");
    context("rex.testnet", &reused);
    reject(&mut market, &reused, "BB:E_ACTION_USED");
    let mut stale = args.clone();
    stale["action_id"] = serde_json::json!("2");
    context("rex.testnet", &stale);
    reject(&mut market, &stale, "BB:E_STALE_LISTING");
}

#[test]
fn deactivation_and_reactivation_keep_stock_reference_prices_and_sequences() {
    let mut market = market();
    let mut args = args();
    args["active"] = serde_json::json!(false);
    args["quantity"] = serde_json::json!("0");
    context("rex.testnet", &args);
    let result = update(&mut market, &args);
    assert!(!result.data.listing.active);
    assert_eq!(result.data.listing.unit_price.0, 7);
    assert_eq!(
        market.market.merchants[0]
            .balances
            .inventory
            .amount(Resource::Crystal),
        15
    );
    args["active"] = serde_json::json!(true);
    args["quantity"] = serde_json::json!("15");
    args["expected_version"] = serde_json::json!("2");
    args["action_id"] = serde_json::json!("2");
    context("rex.testnet", &args);
    let result = update(&mut market, &args);
    assert_eq!(result.data.listing.version.0, 3);
    assert_eq!(result.market_revision.0, 3);
    assert_eq!(result.data.action.action_id.0, 2);
}

#[test]
fn only_the_controller_predecessor_can_change_an_unpaused_listing() {
    let mut market = market();
    let args = args();
    for caller in [
        "owner.testnet",
        "luna.testnet",
        "market.testnet",
        "proxy.testnet",
    ] {
        context(caller, &args);
        reject(&mut market, &args, "BB:E_UNAUTHORIZED");
    }
    context("rex.testnet", &args);
    market.market.paused = true;
    reject(&mut market, &args, "BB:E_MARKET_PAUSED");
}

#[test]
fn revision_and_listing_version_overflow_do_not_consume_actions() {
    let mut market = market();
    let mut args = args();
    market.market.market_revision = u64::MAX;
    context("rex.testnet", &args);
    reject(&mut market, &args, "BB:E_ARITHMETIC_OVERFLOW");
    market.market.market_revision = 1;
    market.market.merchants[0].listings[0].version = u64::MAX;
    args["expected_version"] = serde_json::json!(u64::MAX.to_string());
    context("rex.testnet", &args);
    reject(&mut market, &args, "BB:E_ARITHMETIC_OVERFLOW");
}

#[test]
fn shared_digest_vectors_match_recursive_canonical_json_and_rust_hashing() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/listing-digests.json"
    ))
    .unwrap();
    for vector in vectors {
        let canonical =
            canonical_json(&serde_json::json!({"method":"set_listing","args":vector["args"]}));
        assert_eq!(canonical, vector["canonical"].as_str().unwrap());
        let hash = env::sha256_array(canonical.as_bytes());
        let hex: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, vector["sha256"].as_str().unwrap());
    }
    assert_eq!(
        canonical_json(&serde_json::json!({"z":[{"b":false,"a":"1"}],"a":null})),
        r#"{"a":null,"z":[{"a":"1","b":false}]}"#
    );
}
