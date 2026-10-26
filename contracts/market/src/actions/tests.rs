use super::*;
use crate::{
    Decimal, Market, MerchantControllers, initialization::initialized_state,
    listings::canonical_json, state::*,
};
use near_sdk::{
    borsh,
    serde_json::{self, Value, json},
    test_utils::VMContextBuilder,
    testing_env,
};

fn context(caller: &str, args: &Value) {
    let mut ctx = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .block_timestamp(10_000_000_000)
        .build();
    ctx.input = serde_json::to_vec(args).unwrap().into();
    testing_env!(ctx);
}

fn market() -> Market {
    context("rex.testnet", &json!({}));
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

fn listing(action: u64, price: u64, version: u64) -> Value {
    json!({"merchant_id":"rex","resource":"crystal","unit_price":price.to_string(),"quantity":"2","active":true,"expected_version":version.to_string(),"action_id":action.to_string()})
}

fn proposal(proposer: &str, action: u64) -> Value {
    json!({"proposer":proposer,"buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"24","expires_at_ns":"121000000000","action_id":action.to_string()})
}

fn invoke(market: &mut Market, method: &str, args: &Value) -> Value {
    let n = |key: &str| Decimal(args[key].as_str().unwrap().parse().unwrap());
    match method {
        "set_listing" => serde_json::to_value(market.set_listing(
            MerchantId::Rex,
            Resource::Crystal,
            n("unit_price"),
            n("quantity"),
            true,
            n("expected_version"),
            n("action_id"),
        ))
        .unwrap(),
        "propose_trade" => serde_json::to_value(market.propose_trade(
            serde_json::from_value(args["proposer"].clone()).unwrap(),
            MerchantId::Rex,
            MerchantId::Luna,
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
        _ => panic!("unknown test method"),
    }
}

fn reject(market: &mut Market, method: &str, args: &Value, code: &str) {
    let before = borsh::to_vec(&market.market).unwrap();
    let offer = market
        .market
        .offers
        .get(&1)
        .map(|o| borsh::to_vec(o).unwrap());
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        invoke(market, method, args)
    }))
    .err()
    .unwrap();
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(message.contains(code), "{message}");
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
    assert_eq!(
        market
            .market
            .offers
            .get(&1)
            .map(|o| borsh::to_vec(o).unwrap()),
        offer
    );
}

#[test]
fn shared_vectors_match_all_merchant_methods_and_large_decimal_strings() {
    context("rex.testnet", &json!({}));
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/merchant-action-digests.json"
    ))
    .unwrap();
    for vector in vectors {
        let canonical = canonical_json(&json!({"method":vector["method"],"args":vector["args"]}));
        assert_eq!(canonical, vector["canonical"]);
        let digest: String = env::sha256_array(canonical.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(digest, vector["sha256"]);
    }
}

#[test]
fn one_sequence_spans_all_methods_and_rejects_changed_argument_replays() {
    let mut market = market();
    let args = listing(1, 5, 1);
    context("rex.testnet", &args);
    invoke(&mut market, "set_listing", &args);
    let args = proposal("rex", 1);
    context("rex.testnet", &args);
    reject(&mut market, "propose_trade", &args, "BB:E_ACTION_USED");
    let args = proposal("rex", 3);
    context("rex.testnet", &args);
    reject(&mut market, "propose_trade", &args, "BB:E_ACTION_GAP");
    let args = proposal("rex", 2);
    context("rex.testnet", &args);
    invoke(&mut market, "propose_trade", &args);
    let mut changed = args.clone();
    changed["total_price"] = json!("28");
    context("rex.testnet", &changed);
    reject(&mut market, "propose_trade", &changed, "BB:E_ACTION_USED");
    let args = json!({"offer_id":"1","action_id":"2"});
    context("rex.testnet", &args);
    reject(&mut market, "cancel_trade", &args, "BB:E_ACTION_USED");
    let args = json!({"offer_id":"1","action_id":"3"});
    context("rex.testnet", &args);
    invoke(&mut market, "cancel_trade", &args);
    let args = proposal("luna", 1);
    context("luna.testnet", &args);
    invoke(&mut market, "propose_trade", &args);
    let args = json!({"offer_id":"2","action_id":"3"});
    context("rex.testnet", &args);
    reject(&mut market, "accept_trade", &args, "BB:E_ACTION_USED");
    let args = json!({"offer_id":"2","action_id":"5"});
    context("rex.testnet", &args);
    reject(&mut market, "accept_trade", &args, "BB:E_ACTION_GAP");
    let args = json!({"offer_id":"2","action_id":"4"});
    context("rex.testnet", &args);
    invoke(&mut market, "accept_trade", &args);
    let args = listing(4, 7, 3);
    context("rex.testnet", &args);
    reject(&mut market, "set_listing", &args, "BB:E_ACTION_USED");
    let args = listing(5, 7, 3);
    context("rex.testnet", &args);
    invoke(&mut market, "set_listing", &args);
    assert_eq!(market.market.merchants[0].actions.last_action_id(), 5);
    assert_eq!(market.market.merchants[1].actions.last_action_id(), 1);
    assert_eq!(market.market.trade_ids.next_id(), 2);
    assert_eq!(market.market.merchants[0].balances.gold(), 156);
    assert_eq!(market.market.merchants[1].balances.gold(), 244);
}

#[test]
fn final_u64_action_succeeds_once_then_never_wraps_or_resets() {
    let mut bytes = (u64::MAX - 1).to_le_bytes().to_vec();
    bytes.push(0);
    let mut sequence: ActionSequence = borsh::from_slice(&bytes).unwrap();
    validate_action(&sequence, u64::MAX);
    sequence
        .record(LastAction {
            action_id: u64::MAX,
            method: MerchantMethod::SetListing,
            args_sha256: [1; 32],
            market_revision: 2,
            offer_id: None,
            trade_id: None,
            listing_version: Some(2),
        })
        .unwrap();
    let persisted = borsh::to_vec(&sequence).unwrap();
    let restored: ActionSequence = borsh::from_slice(&persisted).unwrap();
    assert_eq!(
        restored.validate_next(u64::MAX),
        Err(StateError::ActionUsed)
    );
    assert_eq!(restored.validate_next(0), Err(StateError::ActionUsed));
    assert_eq!(restored.next_action_id(), Err(StateError::Overflow));
    assert_eq!(restored.last_action().unwrap().action_id, u64::MAX);
    assert_eq!(borsh::to_vec(&restored).unwrap(), persisted);
}

#[test]
fn old_actions_stay_used_after_receipts_are_replaced_and_offer_trade_history_is_pruned() {
    let mut market = market();
    for id in 1..=101 {
        let (buyer, seller) = if id % 2 == 1 {
            (MerchantId::Rex, MerchantId::Luna)
        } else {
            (MerchantId::Luna, MerchantId::Rex)
        };
        let args = json!({"proposer":"rex","buyer":buyer,"seller":seller,"resource":"crystal","quantity":"1","total_price":"1","expires_at_ns":"121000000000","action_id":id.to_string()});
        context("rex.testnet", &args);
        market.propose_trade(
            MerchantId::Rex,
            buyer,
            seller,
            Resource::Crystal,
            Decimal(1),
            Decimal(1),
            Decimal(121_000_000_000),
            Decimal(id),
        );
        let args = json!({"offer_id":id.to_string(),"action_id":id.to_string()});
        context("luna.testnet", &args);
        market.accept_trade(Decimal(id), Decimal(id));
    }
    assert!(market.market.offers.get(&1).is_none());
    assert!(market.market.trades.get(&1).is_none());
    assert_eq!(market.market.offers_pruned_through, 1);
    assert_eq!(market.market.trades_pruned_through, 1);
    for (method, args, caller, code) in [
        (
            "propose_trade",
            proposal("rex", 1),
            "rex.testnet",
            "BB:E_ACTION_USED",
        ),
        (
            "set_listing",
            listing(1, 6, 1),
            "rex.testnet",
            "BB:E_ACTION_USED",
        ),
        (
            "accept_trade",
            json!({"offer_id":"1","action_id":"1"}),
            "luna.testnet",
            "BB:E_OFFER_PRUNED",
        ),
        (
            "cancel_trade",
            json!({"offer_id":"1","action_id":"1"}),
            "rex.testnet",
            "BB:E_OFFER_PRUNED",
        ),
    ] {
        context(caller, &args);
        reject(&mut market, method, &args, code);
    }
    let args = proposal("rex", 102);
    context("rex.testnet", &args);
    let result = invoke(&mut market, "propose_trade", &args);
    assert_eq!(result["data"]["offer"]["offer_id"], "102");
    assert_eq!(market.market.trade_ids.next_id(), 102);
    assert_eq!(market.market.merchants[0].actions.last_action_id(), 102);
    assert_eq!(market.market.merchants[1].actions.last_action_id(), 101);
}
