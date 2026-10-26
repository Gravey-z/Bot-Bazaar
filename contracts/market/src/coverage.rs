use crate::{
    Decimal, Market, MerchantControllers,
    initialization::{initialized_state, parse_initialization_input},
    state::*,
};
use near_sdk::{
    borsh, env,
    serde_json::{self, Value, json},
    test_utils::{VMContextBuilder, get_logs},
    testing_env,
};

const NOW: u64 = 10_000_000_000;

fn context(caller: &str, signer: &str, args: &Value, now: u64) {
    let mut ctx = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .signer_account_id(signer.parse().unwrap())
        .block_timestamp(now)
        .build();
    ctx.input = serde_json::to_vec(args).unwrap().into();
    testing_env!(ctx);
}

fn controllers() -> MerchantControllers {
    MerchantControllers {
        rex: "rex.testnet".parse().unwrap(),
        luna: "luna.testnet".parse().unwrap(),
        bolt: "bolt.testnet".parse().unwrap(),
    }
}

fn market() -> Market {
    context("owner.testnet", "owner.testnet", &json!({}), NOW);
    near_sdk::mock::with_mocked_blockchain(|blockchain| {
        blockchain.take_storage();
    });
    Market {
        market: initialized_state(
            "owner.testnet".parse().unwrap(),
            controllers(),
            &"market.testnet".parse().unwrap(),
        )
        .unwrap(),
    }
}

fn args(method: &str, merchant: MerchantId) -> Value {
    match method {
        "set_listing" => {
            json!({"merchant_id":merchant,"resource":"crystal","unit_price":"1","quantity":"1","active":true,"expected_version":"1","action_id":"1"})
        }
        "propose_trade" => {
            json!({"proposer":merchant,"buyer":merchant,"seller":if merchant==MerchantId::Rex {MerchantId::Luna}else{MerchantId::Rex},"resource":"crystal","quantity":"1","total_price":"1","expires_at_ns":"121000000000","action_id":"1"})
        }
        "accept_trade" | "cancel_trade" => json!({"offer_id":"1","action_id":"1"}),
        "buy_from_merchant" => {
            json!({"merchant_id":merchant,"resource":"crystal","quantity":"1","max_total_price":"10","listing_version":"1"})
        }
        "expire_offers" => json!({"offer_ids":["1"]}),
        _ => json!({}),
    }
}

fn invoke(market: &mut Market, method: &str, args: &Value) -> Value {
    let n = |key: &str| Decimal(args[key].as_str().unwrap().parse().unwrap());
    match method {
        "register_player" => serde_json::to_value(market.register_player()).unwrap(),
        "pause_market" => serde_json::to_value(market.pause_market()).unwrap(),
        "resume_market" => serde_json::to_value(market.resume_market()).unwrap(),
        "set_listing" => serde_json::to_value(market.set_listing(
            serde_json::from_value(args["merchant_id"].clone()).unwrap(),
            Resource::Crystal,
            n("unit_price"),
            n("quantity"),
            args["active"].as_bool().unwrap(),
            n("expected_version"),
            n("action_id"),
        ))
        .unwrap(),
        "propose_trade" => serde_json::to_value(market.propose_trade(
            serde_json::from_value(args["proposer"].clone()).unwrap(),
            serde_json::from_value(args["buyer"].clone()).unwrap(),
            serde_json::from_value(args["seller"].clone()).unwrap(),
            Resource::Crystal,
            n("quantity"),
            n("total_price"),
            n("expires_at_ns"),
            n("action_id"),
        ))
        .unwrap(),
        "accept_trade" => {
            serde_json::to_value(market.accept_trade(n("offer_id"), n("action_id"))).unwrap()
        }
        "cancel_trade" => {
            serde_json::to_value(market.cancel_trade(n("offer_id"), n("action_id"))).unwrap()
        }
        "buy_from_merchant" => serde_json::to_value(market.buy_from_merchant(
            MerchantId::Rex,
            Resource::Crystal,
            n("quantity"),
            n("max_total_price"),
            n("listing_version"),
        ))
        .unwrap(),
        "expire_offers" => serde_json::to_value(
            market.expire_offers(
                args["offer_ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| Decimal(id.as_str().unwrap().parse().unwrap()))
                    .collect(),
            ),
        )
        .unwrap(),
        _ => panic!("unknown test method"),
    }
}

fn reject(market: &mut Market, method: &str, typed_args: &Value, code: &str) {
    let before = borsh::to_vec(&market.market).unwrap();
    let offer = market
        .market
        .offers
        .get(&1)
        .map(|o| borsh::to_vec(o).unwrap());
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        invoke(market, method, typed_args)
    }))
    .err()
    .unwrap();
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(message.contains(code), "{method}: {message}");
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
    assert_eq!(
        market
            .market
            .offers
            .get(&1)
            .map(|o| borsh::to_vec(o).unwrap()),
        offer
    );
    assert!(get_logs().is_empty());
}

fn pending(market: &mut Market, proposer: MerchantId) {
    let input = args("propose_trade", proposer);
    let caller = market.market.merchants[proposer.index()]
        .controller_account_id
        .to_string();
    context(&caller, &caller, &input, NOW);
    invoke(market, "propose_trade", &input);
}

#[test]
fn every_mutation_rejects_missing_extra_duplicate_and_malformed_request_envelopes() {
    let mut market = market();
    for method in [
        "register_player",
        "pause_market",
        "resume_market",
        "set_listing",
        "propose_trade",
        "accept_trade",
        "cancel_trade",
        "buy_from_merchant",
        "expire_offers",
    ] {
        let typed = args(method, MerchantId::Rex);
        let mut invalid = typed.clone();
        invalid["extra"] = json!("x");
        context("attacker.testnet", "rex.testnet", &invalid, NOW);
        reject(&mut market, method, &typed, "BB:E_INVALID_ARGUMENT");
        for key in typed.as_object().unwrap().keys() {
            let mut missing = typed.clone();
            missing.as_object_mut().unwrap().remove(key);
            context("attacker.testnet", "rex.testnet", &missing, NOW);
            reject(&mut market, method, &typed, "BB:E_INVALID_ARGUMENT");
            let mut wrong = typed.clone();
            wrong[key] = json!({});
            context("attacker.testnet", "rex.testnet", &wrong, NOW);
            reject(&mut market, method, &typed, "BB:E_INVALID_ARGUMENT");
            let duplicate = serde_json::to_string(&typed).unwrap().replacen(
                '{',
                &format!(
                    "{{{}:{},",
                    serde_json::to_string(key).unwrap(),
                    serde_json::to_string(&typed[key]).unwrap()
                ),
                1,
            );
            let mut ctx = VMContextBuilder::new()
                .current_account_id("market.testnet".parse().unwrap())
                .predecessor_account_id("attacker.testnet".parse().unwrap())
                .build();
            ctx.input = duplicate.into_bytes().into();
            testing_env!(ctx);
            reject(&mut market, method, &typed, "BB:E_INVALID_ARGUMENT");
        }
        for malformed in [json!([]), json!(null), json!(true), json!("{}")] {
            context("attacker.testnet", "rex.testnet", &malformed, NOW);
            reject(&mut market, method, &typed, "BB:E_INVALID_ARGUMENT");
        }
    }
}

#[test]
fn controller_permissions_cover_all_merchants_and_stored_offer_roles() {
    for merchant in MerchantId::ALL {
        let controller = format!("{merchant:?}.testnet").to_lowercase();
        for method in ["set_listing", "propose_trade"] {
            let mut market = market();
            let input = args(method, merchant);
            for caller in [
                "owner.testnet",
                "market.testnet",
                "attacker.testnet",
                "proxy.testnet",
                "rex.testnet",
                "luna.testnet",
                "bolt.testnet",
            ] {
                if caller == controller {
                    continue;
                }
                context(caller, &controller, &input, NOW);
                reject(&mut market, method, &input, "BB:E_UNAUTHORIZED");
            }
            context(&controller, "attacker.testnet", &input, NOW);
            invoke(&mut market, method, &input);
            assert_eq!(
                market.market.merchants[merchant.index()]
                    .actions
                    .last_action_id(),
                1
            );
        }
        for method in ["accept_trade", "cancel_trade"] {
            let mut market = market();
            pending(&mut market, merchant);
            let owner = if method == "cancel_trade" {
                merchant
            } else {
                market.market.offers.get(&1).unwrap().counterparty
            };
            let allowed = market.market.merchants[owner.index()]
                .controller_account_id
                .to_string();
            let action = if owner == merchant { 2 } else { 1 };
            let input = json!({"offer_id":"1","action_id":action.to_string()});
            for caller in [
                "owner.testnet",
                "market.testnet",
                "attacker.testnet",
                "proxy.testnet",
                "rex.testnet",
                "luna.testnet",
                "bolt.testnet",
            ] {
                if caller == allowed {
                    continue;
                }
                context(caller, &allowed, &input, NOW);
                reject(&mut market, method, &input, "BB:E_UNAUTHORIZED");
            }
            context(&allowed, "attacker.testnet", &input, NOW);
            invoke(&mut market, method, &input);
            assert_eq!(
                market.market.merchants[owner.index()]
                    .actions
                    .last_action_id(),
                action
            );
        }
    }
}

#[test]
fn paused_public_operation_matrix_blocks_economy_but_allows_cancellation_cleanup_and_reads() {
    let mut market = market();
    pending(&mut market, MerchantId::Rex);
    context("owner.testnet", "owner.testnet", &json!({}), NOW);
    market.pause_market();
    for (method, caller) in [
        ("register_player", "player.testnet"),
        ("set_listing", "rex.testnet"),
        ("propose_trade", "rex.testnet"),
        ("accept_trade", "luna.testnet"),
        ("buy_from_merchant", "player.testnet"),
    ] {
        let input = args(method, MerchantId::Rex);
        context(caller, caller, &input, NOW);
        reject(&mut market, method, &input, "BB:E_MARKET_PAUSED");
    }
    context("reader.testnet", "reader.testnet", &json!({}), NOW);
    assert!(market.get_market_state().data.paused);
    let input = json!({"offer_id":"1","action_id":"2"});
    context("rex.testnet", "rex.testnet", &input, NOW);
    invoke(&mut market, "cancel_trade", &input);
    let input = json!({"offer_ids":["1"]});
    context("attacker.testnet", "attacker.testnet", &input, NOW);
    let ignored = invoke(&mut market, "expire_offers", &input);
    assert!(
        ignored["data"]["expired_offer_ids"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(market.market.paused);
    let mut market = self::market();
    pending(&mut market, MerchantId::Rex);
    market.market.paused = true;
    context(
        "attacker.testnet",
        "attacker.testnet",
        &input,
        121_000_000_000,
    );
    let expired = invoke(&mut market, "expire_offers", &input);
    assert_eq!(expired["data"]["expired_offer_ids"], json!(["1"]));
    assert!(market.market.paused);
}

#[test]
fn initializer_authorization_and_nested_duplicate_fields_are_checked_without_logging() {
    let valid = json!({"owner_account_id":"owner.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}});
    for caller in [
        "owner.testnet",
        "attacker.testnet",
        "proxy.testnet",
        "rex.testnet",
    ] {
        context(caller, "market.testnet", &valid, NOW);
        let before = env::state_read::<Market>().map(|m| borsh::to_vec(&m).unwrap());
        let error = std::panic::catch_unwind(|| {
            Market::initialize_market("owner.testnet".parse().unwrap(), controllers())
        })
        .err()
        .unwrap();
        let message = error
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| error.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(message.contains("BB:E_UNAUTHORIZED"));
        assert!(get_logs().is_empty());
        assert_eq!(
            env::state_read::<Market>().map(|m| borsh::to_vec(&m).unwrap()),
            before
        );
    }
    for bytes in [br#"{"owner_account_id":"owner.testnet","merchant_controllers":{"rex":"rex.testnet","rex":"other.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}}"#.as_slice(),
        br#"{"owner_account_id":"owner.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet","extra":"x.testnet"}}"#] {
        assert!(parse_initialization_input(bytes).is_none());
    }
}

#[test]
fn cleanup_revision_overflow_rejects_before_closing_and_an_ignored_batch_still_succeeds() {
    let mut market = market();
    pending(&mut market, MerchantId::Rex);
    market.market.market_revision = u64::MAX;
    let input = json!({"offer_ids":["1"]});
    context(
        "attacker.testnet",
        "attacker.testnet",
        &input,
        121_000_000_000,
    );
    reject(
        &mut market,
        "expire_offers",
        &input,
        "BB:E_ARITHMETIC_OVERFLOW",
    );
    let input = json!({"offer_ids":["999"]});
    context(
        "attacker.testnet",
        "attacker.testnet",
        &input,
        121_000_000_000,
    );
    let result = invoke(&mut market, "expire_offers", &input);
    assert_eq!(result["market_revision"], u64::MAX.to_string());
    assert!(get_logs().is_empty());
    assert_eq!(
        market.market.offers.get(&1).unwrap().status,
        OfferStatus::Pending
    );
}

#[test]
fn purchases_spend_only_the_registered_predecessor_not_the_original_signer() {
    let mut market = market();
    context("player.testnet", "player.testnet", &json!({}), NOW);
    market.register_player();
    let input = args("buy_from_merchant", MerchantId::Rex);
    context("proxy.testnet", "player.testnet", &input, NOW);
    reject(
        &mut market,
        "buy_from_merchant",
        &input,
        "BB:E_NOT_REGISTERED",
    );
    context("proxy.testnet", "player.testnet", &json!({}), NOW);
    market.register_player();
    context("proxy.testnet", "player.testnet", &input, NOW);
    let result = invoke(&mut market, "buy_from_merchant", &input);
    assert_eq!(
        result["data"]["buyer"],
        json!({"kind":"player","account_id":"proxy.testnet"})
    );
    let original = market
        .market
        .players
        .get(&"player.testnet".parse::<near_sdk::AccountId>().unwrap())
        .unwrap();
    assert_eq!(original.balances.gold(), 100);
    assert_eq!(original.balances.inventory, Inventory::default());
    let proxy = market
        .market
        .players
        .get(&"proxy.testnet".parse::<near_sdk::AccountId>().unwrap())
        .unwrap();
    assert_eq!(proxy.balances.gold(), 96);
    assert_eq!(proxy.balances.inventory.amount(Resource::Crystal), 1);
    assert_eq!(market.market.registered_player_count, 2);
    assert_eq!(market.market.total_issued_gold, 750);
}
