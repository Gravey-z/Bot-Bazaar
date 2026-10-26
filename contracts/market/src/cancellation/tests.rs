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
    let mut ctx = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .signer_account_id("rex.testnet".parse().unwrap())
        .block_timestamp(now)
        .build();
    ctx.input = serde_json::to_vec(args).unwrap().into();
    testing_env!(ctx);
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

fn propose(market: &mut Market, proposer: MerchantId, action: u64) {
    let args = json!({"proposer":proposer,"buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"24","expires_at_ns":"121000000000","action_id":action.to_string()});
    let caller = market.market.merchants[proposer.index()]
        .controller_account_id
        .to_string();
    context(&caller, &args, NOW);
    market.propose_trade(
        proposer,
        MerchantId::Rex,
        MerchantId::Luna,
        Resource::Crystal,
        Decimal(4),
        Decimal(24),
        Decimal(121_000_000_000),
        Decimal(action),
    );
}

fn pending() -> Market {
    let mut market = market();
    propose(&mut market, MerchantId::Rex, 1);
    market
}

fn cancel_context(caller: &str, id: u64, action: u64, now: u64) {
    context(
        caller,
        &json!({"offer_id":id.to_string(),"action_id":action.to_string()}),
        now,
    );
}

fn reject(market: &mut Market, id: u64, action: u64, code: &str) {
    let root = borsh::to_vec(&market.market).unwrap();
    let offer = market
        .market
        .offers
        .get(&1)
        .map(|o| borsh::to_vec(o).unwrap());
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        market.cancel_trade(Decimal(id), Decimal(action))
    }))
    .err()
    .unwrap();
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(message.contains(code), "{message}");
    assert_eq!(borsh::to_vec(&market.market).unwrap(), root);
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
fn cancellation_returns_exact_receipt_and_releases_slots_without_economic_changes() {
    let mut market = pending();
    context("reader.testnet", &json!({}), NOW);
    let before = serde_json::to_value(market.get_market_state()).unwrap();
    let original = borsh::to_vec(market.market.offers.get(&1).unwrap()).unwrap();
    cancel_context("rex.testnet", 1, 2, NOW + 1);
    let result = serde_json::to_value(market.cancel_trade(Decimal(1), Decimal(2))).unwrap();
    assert_eq!(result["market_revision"], "3");
    let digest: String =
        env::sha256_array(br#"{"args":{"action_id":"2","offer_id":"1"},"method":"cancel_trade"}"#)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
    assert_eq!(
        result["data"]["action"],
        json!({"action_id":"2","method":"cancel_trade","args_sha256":digest,"market_revision":"3","offer_id":"1","trade_id":null,"listing_version":null})
    );
    let mut expected = OfferView::at(&borsh::from_slice::<Offer>(&original).unwrap(), NOW + 1);
    expected.status = OfferStatus::Cancelled;
    expected.closed_at_ns = Some(U64(NOW + 1));
    assert_eq!(
        result["data"]["offer"],
        serde_json::to_value(expected).unwrap()
    );
    context("reader.testnet", &json!({}), NOW + 1);
    let after = serde_json::to_value(market.get_market_state()).unwrap();
    for (old, new) in before["data"]["merchants"]
        .as_array()
        .unwrap()
        .iter()
        .zip(after["data"]["merchants"].as_array().unwrap())
    {
        for field in ["gold", "inventory", "listings"] {
            assert_eq!(old[field], new[field]);
        }
    }
    for field in [
        "total_issued_gold",
        "resource_supply",
        "registered_player_count",
        "next_offer_id",
        "next_trade_id",
    ] {
        assert_eq!(before["data"][field], after["data"][field]);
    }
    assert!(market.market.pending_offer_ids.iter().all(Option::is_none));
    assert!(
        market
            .market
            .merchants
            .iter()
            .all(|m| m.pending_offer_count == 0)
    );
    assert_eq!(market.market.terminal_offer_ids.count, 1);
    assert_eq!(market.market.trade_history_ids.count, 0);
}

#[test]
fn buyer_and_seller_proposers_can_cancel_while_paused() {
    for proposer in [MerchantId::Rex, MerchantId::Luna] {
        let mut market = market();
        propose(&mut market, proposer, 1);
        market.market.paused = true;
        let caller = market.market.merchants[proposer.index()]
            .controller_account_id
            .to_string();
        cancel_context(&caller, 1, 2, NOW);
        market.cancel_trade(Decimal(1), Decimal(2));
        assert!(market.market.paused);
        assert_eq!(
            market.market.offers.get(&1).unwrap().status,
            OfferStatus::Cancelled
        );
    }
}

#[test]
fn authorization_and_sequence_failures_preserve_offer_and_action_for_corrected_retry() {
    let mut market = pending();
    for caller in [
        "owner.testnet",
        "luna.testnet",
        "bolt.testnet",
        "market.testnet",
        "proxy.testnet",
    ] {
        cancel_context(caller, 1, 2, NOW);
        reject(&mut market, 1, 2, "BB:E_UNAUTHORIZED");
    }
    for (id, code) in [(1, "BB:E_ACTION_USED"), (3, "BB:E_ACTION_GAP")] {
        cancel_context("rex.testnet", 1, id, NOW);
        reject(&mut market, 1, id, code);
    }
    cancel_context("rex.testnet", 1, 2, NOW);
    market.cancel_trade(Decimal(1), Decimal(2));
    for id in [2, 3] {
        cancel_context("rex.testnet", 1, id, NOW);
        reject(&mut market, 1, id, "BB:E_OFFER_CANCELLED");
    }
    assert_eq!(market.market.merchants[0].actions.last_action_id(), 2);
}

#[test]
fn expiry_equality_cleanup_and_accepted_or_missing_offers_cannot_be_cancelled() {
    let mut market = pending();
    cancel_context("rex.testnet", 1, 2, 121_000_000_000);
    reject(&mut market, 1, 2, "BB:E_OFFER_EXPIRED");
    market.market.expire_offers(&[1], 121_000_000_000).unwrap();
    reject(&mut market, 1, 2, "BB:E_OFFER_EXPIRED");
    for (id, code) in [(0, "BB:E_INVALID_ARGUMENT"), (2, "BB:E_OFFER_NOT_FOUND")] {
        cancel_context("rex.testnet", id, 2, NOW);
        reject(&mut market, id, 2, code);
    }
    let mut market = pending();
    cancel_context("luna.testnet", 1, 1, NOW);
    market.accept_trade(Decimal(1), Decimal(1));
    cancel_context("rex.testnet", 1, 2, NOW);
    reject(&mut market, 1, 2, "BB:E_OFFER_ACCEPTED");
}

#[test]
fn overflow_and_invalid_pending_index_do_not_partially_cancel() {
    let mut market = pending();
    cancel_context("rex.testnet", 1, 2, NOW);
    market.market.market_revision = u64::MAX;
    reject(&mut market, 1, 2, "BB:E_ARITHMETIC_OVERFLOW");
    market.market.market_revision = 2;
    market.market.pending_offer_ids[0] = None;
    reject(&mut market, 1, 2, "BB:E_INVALID_ARGUMENT");
    market.market.pending_offer_ids[0] = Some(1);
    market.cancel_trade(Decimal(1), Decimal(2));
    assert_eq!(
        market.market.offers.get(&1).unwrap().status,
        OfferStatus::Cancelled
    );
}

#[test]
fn cancellation_releases_capacity_and_fifo_pruning_never_restores_old_offers() {
    let mut market = market();
    for id in 1..=8 {
        propose(&mut market, MerchantId::Rex, id);
    }
    cancel_context("rex.testnet", 1, 9, NOW);
    market.cancel_trade(Decimal(1), Decimal(9));
    propose(&mut market, MerchantId::Rex, 10);
    assert_eq!(market.market.merchants[0].pending_offer_count, 8);
    assert_eq!(market.market.merchants[1].pending_offer_count, 8);
    for id in 2..=9 {
        cancel_context("rex.testnet", id, id + 9, NOW);
        market.cancel_trade(Decimal(id), Decimal(id + 9));
    }
    for id in 10..=101 {
        let action = id * 2 - 1;
        propose(&mut market, MerchantId::Rex, action);
        cancel_context("rex.testnet", id, action + 1, NOW);
        market.cancel_trade(Decimal(id), Decimal(action + 1));
    }
    assert_eq!(market.market.terminal_offer_ids.count, 100);
    assert!(market.market.offers.get(&1).is_none());
    assert_eq!(market.market.offers_pruned_through, 1);
    assert_eq!(market.market.offer_ids.next_id(), 102);
    assert_eq!(market.market.trade_ids.next_id(), 1);
    cancel_context("rex.testnet", 1, 203, NOW);
    reject(&mut market, 1, 203, "BB:E_OFFER_PRUNED");
    assert_eq!(market.market.merchants[0].actions.last_action_id(), 202);
}
