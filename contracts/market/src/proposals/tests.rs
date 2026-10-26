use super::*;
use crate::{MerchantControllers, initialization::initialized_state, state::*};
use near_sdk::{
    borsh,
    serde_json::{self, Value},
    test_utils::VMContextBuilder,
    testing_env,
};

const NOW: u64 = 10_000_000_000;

fn context(caller: &str, args: &Value, now: u64) {
    let mut context = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .signer_account_id("rex.testnet".parse().unwrap())
        .block_timestamp(now)
        .build();
    context.input = serde_json::to_vec(args).unwrap().into();
    testing_env!(context);
}

fn market() -> Market {
    context("rex.testnet", &json!({}), NOW);
    near_sdk::mock::with_mocked_blockchain(|blockchain| {
        blockchain.take_storage();
    });
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
    json!({"proposer":"rex","buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"24","expires_at_ns":"121000000000","action_id":"1"})
}

fn propose(market: &mut Market, args: &Value) -> Snapshot<OfferResult> {
    market.propose_trade(
        serde_json::from_value(args["proposer"].clone()).unwrap(),
        serde_json::from_value(args["buyer"].clone()).unwrap(),
        serde_json::from_value(args["seller"].clone()).unwrap(),
        serde_json::from_value(args["resource"].clone()).unwrap(),
        serde_json::from_value(args["quantity"].clone()).unwrap(),
        serde_json::from_value(args["total_price"].clone()).unwrap(),
        serde_json::from_value(args["expires_at_ns"].clone()).unwrap(),
        serde_json::from_value(args["action_id"].clone()).unwrap(),
    )
}

fn reject(market: &mut Market, args: &Value, code: &str) {
    let before = borsh::to_vec(&market.market).unwrap();
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| propose(market, args)))
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
fn both_proposer_roles_record_exact_terms_without_reserving_assets() {
    let mut market = market();
    let balances: Vec<_> = market.market.merchants.iter().map(|m| m.balances).collect();
    let listings: Vec<_> = market.market.merchants.iter().map(|m| m.listings).collect();
    for (index, proposer, caller, counterparty) in [
        (0, "rex", "rex.testnet", "luna"),
        (1, "luna", "luna.testnet", "rex"),
    ] {
        let mut args = args();
        args["proposer"] = json!(proposer);
        context(caller, &args, NOW);
        let result = serde_json::to_value(propose(&mut market, &args)).unwrap();
        let id = (index + 1).to_string();
        assert_eq!(result["market_revision"], (index + 2).to_string());
        assert_eq!(
            result["data"]["offer"],
            json!({
                "offer_id":id,"proposer":proposer,"buyer":"rex","seller":"luna","counterparty":counterparty,
                "resource":"crystal","quantity":"4","unit_price":"6","total_price":"24",
                "created_at_ns":NOW.to_string(),"expires_at_ns":"121000000000","status":"pending",
                "closed_at_ns":null,"settled_trade_id":null,"proposal_action":{"merchant_id":proposer,"action_id":"1"}
            })
        );
        let action = &result["data"]["action"];
        assert_eq!(action["method"], "propose_trade");
        assert_eq!(action["offer_id"], id);
        assert_eq!(action["action_id"], "1");
        assert_eq!(action["market_revision"], result["market_revision"]);
        assert_eq!(action["trade_id"], Value::Null);
        assert_eq!(action["listing_version"], Value::Null);
        if index == 0 {
            let canonical = r#"{"args":{"action_id":"1","buyer":"rex","expires_at_ns":"121000000000","proposer":"rex","quantity":"4","resource":"crystal","seller":"luna","total_price":"24"},"method":"propose_trade"}"#;
            let digest: String = env::sha256_array(canonical.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert_eq!(action["args_sha256"], digest);
        }
        let stored = market.market.offers.get(&(index + 1)).unwrap();
        assert_eq!(stored.status, OfferStatus::Pending);
        assert_eq!(stored.total_price, 24);
    }
    assert_eq!(
        market
            .market
            .merchants
            .iter()
            .map(|m| m.balances)
            .collect::<Vec<_>>(),
        balances
    );
    assert_eq!(
        market
            .market
            .merchants
            .iter()
            .map(|m| m.listings)
            .collect::<Vec<_>>(),
        listings
    );
    assert_eq!(
        market
            .market
            .merchants
            .iter()
            .map(|m| m.pending_offer_count)
            .collect::<Vec<_>>(),
        vec![2, 2, 0]
    );
    assert_eq!(market.market.offer_ids.next_id(), 3);
    assert_eq!(market.market.trade_ids.next_id(), 1);
    assert_eq!(market.market.total_issued_gold, 550);
    assert_eq!(
        market.market.resource_supply,
        Inventory::new([29, 25, 26, 24]).unwrap()
    );
}

#[test]
fn invalid_roles_and_economic_terms_preserve_state_and_action_id() {
    let mut market = market();
    for (field, value, code) in [
        ("seller", "rex", "BB:E_INVALID_ROLES"),
        ("proposer", "bolt", "BB:E_INVALID_ROLES"),
        ("quantity", "0", "BB:E_INVALID_QUANTITY"),
        ("quantity", "101", "BB:E_INVALID_QUANTITY"),
        ("total_price", "0", "BB:E_INVALID_TOTAL"),
        ("total_price", "10001", "BB:E_INVALID_TOTAL"),
        ("total_price", "23", "BB:E_NON_INTEGER_UNIT_PRICE"),
        ("total_price", "404", "BB:E_INVALID_PRICE"),
        ("quantity", "13", "BB:E_NON_INTEGER_UNIT_PRICE"),
    ] {
        let mut args = args();
        args[field] = json!(value);
        context(
            if field == "proposer" {
                "bolt.testnet"
            } else {
                "rex.testnet"
            },
            &args,
            NOW,
        );
        reject(&mut market, &args, code);
        assert!(market.market.offers.get(&1).is_none());
    }
    let args = args();
    context("rex.testnet", &args, NOW);
    propose(&mut market, &args);
    assert_eq!(market.market.offer_ids.next_id(), 2);
}

#[test]
fn expiry_is_strict_at_now_inclusive_at_ten_minutes_and_checked() {
    let mut market = market();
    for expiry in [NOW - 1, NOW, NOW + MAX_OFFER_LIFETIME_NS + 1] {
        let mut args = args();
        args["expires_at_ns"] = json!(expiry.to_string());
        context("rex.testnet", &args, NOW);
        reject(&mut market, &args, "BB:E_INVALID_EXPIRY");
    }
    let mut args = args();
    args["expires_at_ns"] = json!((NOW + MAX_OFFER_LIFETIME_NS).to_string());
    context("rex.testnet", &args, NOW);
    propose(&mut market, &args);
    args["action_id"] = json!("2");
    args["expires_at_ns"] = json!(u64::MAX.to_string());
    context("rex.testnet", &args, u64::MAX - 1);
    reject(&mut market, &args, "BB:E_ARITHMETIC_OVERFLOW");
}

#[test]
fn authorization_pause_and_shared_action_sequence_are_enforced() {
    let mut market = market();
    let mut args = args();
    for caller in [
        "owner.testnet",
        "luna.testnet",
        "bolt.testnet",
        "market.testnet",
        "proxy.testnet",
    ] {
        context(caller, &args, NOW);
        reject(&mut market, &args, "BB:E_UNAUTHORIZED");
    }
    context("rex.testnet", &args, NOW);
    market.market.paused = true;
    reject(&mut market, &args, "BB:E_MARKET_PAUSED");
    market.market.paused = false;
    for (id, code) in [("0", "BB:E_ACTION_USED"), ("2", "BB:E_ACTION_GAP")] {
        args["action_id"] = json!(id);
        context("rex.testnet", &args, NOW);
        reject(&mut market, &args, code);
    }
    args["action_id"] = json!("1");
    context("rex.testnet", &args, NOW);
    propose(&mut market, &args);
    reject(&mut market, &args, "BB:E_ACTION_USED");
    let listing = json!({"merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"2","active":true,"expected_version":"1","action_id":"2"});
    context("rex.testnet", &listing, NOW);
    market.set_listing(
        MerchantId::Rex,
        Resource::Crystal,
        Decimal(5),
        Decimal(2),
        true,
        Decimal(1),
        Decimal(2),
    );
    args["action_id"] = json!("2");
    context("rex.testnet", &args, NOW);
    reject(&mut market, &args, "BB:E_ACTION_USED");
    args["action_id"] = json!("3");
    context("rex.testnet", &args, NOW);
    propose(&mut market, &args);
    assert_eq!(market.market.merchants[0].actions.last_action_id(), 3);
}

#[test]
fn current_funds_stock_and_both_resulting_caps_are_validated() {
    let mut market = market();
    let args = args();
    context("rex.testnet", &args, NOW);
    let original = market
        .market
        .merchants
        .iter()
        .map(|m| m.balances)
        .collect::<Vec<_>>();
    for (index, gold, inventory, code) in [
        (0, 23, [15, 4, 2, 10], "BB:E_INSUFFICIENT_GOLD"),
        (1, 220, [3, 3, 20, 2], "BB:E_INSUFFICIENT_STOCK"),
        (0, 180, [997, 4, 2, 10], "BB:E_BALANCE_CAP"),
        (1, MAX_ACTOR_GOLD - 23, [12, 3, 20, 2], "BB:E_BALANCE_CAP"),
    ] {
        market.market.merchants[index].balances =
            Balances::new(gold, Inventory::new(inventory).unwrap()).unwrap();
        reject(&mut market, &args, code);
        market.market.merchants[index].balances = original[index];
    }
    market.market.merchants[0].balances =
        Balances::new(24, Inventory::new([996, 4, 2, 10]).unwrap()).unwrap();
    market.market.merchants[1].balances =
        Balances::new(MAX_ACTOR_GOLD - 24, Inventory::new([4, 3, 20, 2]).unwrap()).unwrap();
    propose(&mut market, &args);
    assert_eq!(market.market.merchants[0].balances.gold(), 24);
    assert_eq!(
        market.market.merchants[1]
            .balances
            .inventory
            .amount(Resource::Crystal),
        4
    );
}

#[test]
fn maximum_quantity_total_and_unit_price_are_inclusive() {
    let mut market = market();
    let mut args = args();
    market.market.merchants[0].balances = Balances::new(10000, Inventory::default()).unwrap();
    market.market.merchants[1].balances =
        Balances::new(0, Inventory::new([100, 0, 0, 0]).unwrap()).unwrap();
    args["quantity"] = json!("100");
    args["total_price"] = json!("10000");
    context("rex.testnet", &args, NOW);
    let result = propose(&mut market, &args);
    assert_eq!(result.data.offer.unit_price.0, 100);
    assert_eq!(result.data.offer.quantity.0, 100);
    assert_eq!(result.data.offer.total_price.0, 10000);
}

#[test]
fn expired_pending_slots_require_cleanup_and_both_merchants_count_toward_capacity() {
    let mut market = market();
    let mut args = args();
    for id in 1..=8 {
        args["action_id"] = json!(id.to_string());
        context("rex.testnet", &args, NOW);
        propose(&mut market, &args);
    }
    args["action_id"] = json!("9");
    context("rex.testnet", &args, NOW);
    reject(&mut market, &args, "BB:E_OFFER_CAPACITY");
    args["proposer"] = json!("bolt");
    args["buyer"] = json!("bolt");
    args["action_id"] = json!("1");
    context("bolt.testnet", &args, NOW);
    reject(&mut market, &args, "BB:E_OFFER_CAPACITY");
    args["expires_at_ns"] = json!("122000000000");
    context("bolt.testnet", &args, 121_000_000_000);
    reject(&mut market, &args, "BB:E_OFFER_CAPACITY");
    market.market.expire_offers(&[1], 121_000_000_000).unwrap();
    propose(&mut market, &args);
    assert_eq!(market.market.offer_ids.next_id(), 10);
    assert_eq!(market.market.merchants[1].pending_offer_count, 8);
    assert_eq!(market.market.merchants[2].pending_offer_count, 1);
}

#[test]
fn overflow_and_offer_id_collision_do_not_partially_create_offers() {
    let mut market = market();
    let mut args = args();
    context("rex.testnet", &args, NOW);
    market.market.market_revision = u64::MAX;
    reject(&mut market, &args, "BB:E_ARITHMETIC_OVERFLOW");
    market.market.market_revision = 1;
    market.market.offer_ids = borsh::from_slice(&u64::MAX.to_le_bytes()).unwrap();
    reject(&mut market, &args, "BB:E_ARITHMETIC_OVERFLOW");
    market.market.offer_ids = IdSequence::default();
    propose(&mut market, &args);
    market.market.offer_ids = IdSequence::default();
    args["action_id"] = json!("2");
    context("rex.testnet", &args, NOW);
    reject(&mut market, &args, "BB:E_INVALID_ARGUMENT");
    assert_eq!(
        market
            .market
            .offers
            .get(&1)
            .unwrap()
            .proposal_action
            .action_id,
        1
    );
    assert_eq!(market.market.pending_offer_ids.iter().flatten().count(), 1);
}
