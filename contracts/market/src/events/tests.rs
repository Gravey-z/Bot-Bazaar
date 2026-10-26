use super::*;
use crate::{Decimal, MerchantControllers, OfferFilter, state::*};
use near_sdk::{
    serde_json::{self, Value, json},
    test_utils::{VMContextBuilder, get_logs},
    testing_env,
};

const NOW: u64 = 10_000_000_000;

fn context(caller: &str, args: Value, now: u64) {
    let mut ctx = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .block_height(42)
        .block_timestamp(now)
        .build();
    ctx.input = serde_json::to_vec(&args).unwrap().into();
    testing_env!(ctx);
}

fn market() -> Market {
    let args = json!({"owner_account_id":"owner.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}});
    context("market.testnet", args, NOW);
    near_sdk::mock::with_mocked_blockchain(|blockchain| {
        blockchain.take_storage();
    });
    Market::initialize_market(
        "owner.testnet".parse().unwrap(),
        MerchantControllers {
            rex: "rex.testnet".parse().unwrap(),
            luna: "luna.testnet".parse().unwrap(),
            bolt: "bolt.testnet".parse().unwrap(),
        },
    )
}

fn event<T: Serialize>(method: &str, caller: &str, result: &Snapshot<T>) {
    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    let parsed: Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    let snapshot = serde_json::to_value(result).unwrap();
    assert_eq!(
        parsed,
        json!({"standard":"bot_bazaar","version":"1.0.0","event":method,"data":[{
            "initiator_account_id":caller,"market_revision":snapshot["market_revision"],"block_height":"42",
            "block_timestamp_ns":snapshot["block_timestamp_ns"],"result":snapshot["data"]
        }]})
    );
    assert!(parsed["data"][0]["market_revision"].is_string());
    assert!(parsed["data"][0]["block_timestamp_ns"].is_string());
}

fn propose(market: &mut Market, action: u64, expiry: u64) {
    context(
        "rex.testnet",
        json!({"proposer":"rex","buyer":"rex","seller":"luna","resource":"crystal","quantity":"1","total_price":"6","expires_at_ns":expiry.to_string(),"action_id":action.to_string()}),
        NOW,
    );
    let result = market.propose_trade(
        MerchantId::Rex,
        MerchantId::Rex,
        MerchantId::Luna,
        Resource::Crystal,
        Decimal(1),
        Decimal(6),
        Decimal(expiry),
        Decimal(action),
    );
    event("propose_trade", "rex.testnet", &result);
}

#[test]
fn every_state_changing_endpoint_logs_one_exact_result_with_wire_metadata() {
    let mut market = market();
    event(
        "initialize_market",
        "market.testnet",
        &market.market_snapshot(),
    );
    context("player.testnet", json!({}), NOW);
    let result = market.register_player();
    event("register_player", "player.testnet", &result);
    context(
        "rex.testnet",
        json!({"merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"2","active":true,"expected_version":"1","action_id":"1"}),
        NOW,
    );
    let result = market.set_listing(
        MerchantId::Rex,
        Resource::Crystal,
        Decimal(5),
        Decimal(2),
        true,
        Decimal(1),
        Decimal(1),
    );
    event("set_listing", "rex.testnet", &result);
    context(
        "player.testnet",
        json!({"merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"5","listing_version":"2"}),
        NOW,
    );
    let result = market.buy_from_merchant(
        MerchantId::Rex,
        Resource::Crystal,
        Decimal(1),
        Decimal(5),
        Decimal(2),
    );
    event("buy_from_merchant", "player.testnet", &result);
    propose(&mut market, 2, NOW + 1_000_000_000);
    context("luna.testnet", json!({"offer_id":"1","action_id":"1"}), NOW);
    let result = market.accept_trade(Decimal(1), Decimal(1));
    event("accept_trade", "luna.testnet", &result);
    propose(&mut market, 3, NOW + 1_000_000_000);
    context("rex.testnet", json!({"offer_id":"2","action_id":"4"}), NOW);
    let result = market.cancel_trade(Decimal(2), Decimal(4));
    event("cancel_trade", "rex.testnet", &result);
    context("owner.testnet", json!({}), NOW);
    let result = market.pause_market();
    event("pause_market", "owner.testnet", &result);
    context("owner.testnet", json!({}), NOW);
    let result = market.resume_market();
    event("resume_market", "owner.testnet", &result);
    propose(&mut market, 5, NOW + 1);
    context("cleaner.testnet", json!({"offer_ids":["3"]}), NOW + 1);
    let result = market.expire_offers(vec![Decimal(3)]);
    event("expire_offers", "cleaner.testnet", &result);
    assert_eq!(result.market_revision.0, 12);
    assert_eq!(result.data.expired_offer_ids[0].0, 3);
}

#[test]
fn views_and_no_change_calls_emit_no_events_or_revision_increments() {
    let mut market = market();
    context("owner.testnet", json!({}), NOW);
    let result = market.resume_market();
    assert!(!result.data.changed);
    assert!(get_logs().is_empty());
    assert_eq!(result.market_revision.0, 1);
    market.pause_market();
    context("owner.testnet", json!({}), NOW);
    let result = market.pause_market();
    assert!(!result.data.changed);
    assert_eq!(result.market_revision.0, 2);
    assert!(get_logs().is_empty());
    context("reader.testnet", json!({}), NOW);
    market.get_market_state();
    assert!(get_logs().is_empty());
    context(
        "reader.testnet",
        json!({"account_id":"reader.testnet"}),
        NOW,
    );
    market.get_player("reader.testnet".parse().unwrap());
    assert!(get_logs().is_empty());
    context("reader.testnet", json!({"merchant_id":"rex"}), NOW);
    market.get_merchant(MerchantId::Rex);
    assert!(get_logs().is_empty());
    context("reader.testnet", json!({"offer_id":"1"}), NOW);
    market.get_offer(Decimal(1));
    assert!(get_logs().is_empty());
    context(
        "reader.testnet",
        json!({"merchant_id":"rex","status":"all","after_id":null,"limit":"1","expected_revision":null}),
        NOW,
    );
    market.get_offers_for_merchant(MerchantId::Rex, OfferFilter::All, None, Decimal(1), None);
    assert!(get_logs().is_empty());
    context(
        "reader.testnet",
        json!({"after_id":null,"limit":"1","expected_revision":null}),
        NOW,
    );
    market.get_recent_trades(None, Decimal(1), None);
    assert!(get_logs().is_empty());
    context("reader.testnet", json!({"offer_ids":["1"]}), NOW);
    let result = market.expire_offers(vec![Decimal(1)]);
    assert!(result.data.expired_offer_ids.is_empty());
    assert_eq!(result.market_revision.0, 2);
    assert!(get_logs().is_empty());
}

#[test]
fn validation_failures_emit_no_success_events() {
    let mut market = market();
    context("attacker.testnet", json!({}), NOW);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| market.pause_market())).is_err()
    );
    assert!(get_logs().is_empty());
    context("player.testnet", json!({}), NOW);
    market.register_player();
    context("player.testnet", json!({}), NOW);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| market.register_player()))
            .is_err()
    );
    assert!(get_logs().is_empty());
    context(
        "player.testnet",
        json!({"merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"4","listing_version":"0"}),
        NOW,
    );
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| market.buy_from_merchant(
            MerchantId::Rex,
            Resource::Crystal,
            Decimal(1),
            Decimal(4),
            Decimal(0)
        )))
        .is_err()
    );
    assert!(get_logs().is_empty());
}
