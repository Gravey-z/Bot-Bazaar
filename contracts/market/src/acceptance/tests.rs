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
        .signer_account_id("luna.testnet".parse().unwrap())
        .block_timestamp(now)
        .build();
    ctx.input = serde_json::to_vec(args).unwrap().into();
    testing_env!(ctx);
}

fn market() -> Market {
    context("market.testnet", &json!({}), NOW);
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

fn propose(
    market: &mut Market,
    proposer: MerchantId,
    buyer: MerchantId,
    seller: MerchantId,
    quantity: u64,
    total: u64,
    action: u64,
) {
    let args = json!({"proposer":proposer,"buyer":buyer,"seller":seller,"resource":"crystal","quantity":quantity.to_string(),"total_price":total.to_string(),"expires_at_ns":"121000000000","action_id":action.to_string()});
    let caller = market.market.merchants[proposer.index()]
        .controller_account_id
        .to_string();
    context(&caller, &args, NOW);
    market.propose_trade(
        proposer,
        buyer,
        seller,
        Resource::Crystal,
        Decimal(quantity),
        Decimal(total),
        Decimal(121_000_000_000),
        Decimal(action),
    );
}

fn pending() -> Market {
    let mut market = market();
    propose(
        &mut market,
        MerchantId::Rex,
        MerchantId::Rex,
        MerchantId::Luna,
        4,
        24,
        1,
    );
    market
}

fn accept(market: &mut Market, id: u64, action: u64) -> Snapshot<SettlementResult> {
    market.accept_trade(Decimal(id), Decimal(action))
}

fn set_accept_context(caller: &str, id: u64, action: u64, now: u64) {
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
    let trade = market
        .market
        .trades
        .get(&1)
        .map(|t| borsh::to_vec(t).unwrap());
    let error =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| accept(market, id, action)))
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
    assert_eq!(
        market
            .market
            .trades
            .get(&1)
            .map(|t| borsh::to_vec(t).unwrap()),
        trade
    );
}

#[test]
fn fixture_purchase_and_restock_settle_exactly_and_conserve_every_asset() {
    let mut market = market();
    context("player.testnet", &json!({}), NOW);
    market.register_player();
    let buy = json!({"merchant_id":"rex","resource":"crystal","quantity":"12","max_total_price":"48","listing_version":"1"});
    context("player.testnet", &buy, NOW);
    market.buy_from_merchant(
        MerchantId::Rex,
        Resource::Crystal,
        Decimal(12),
        Decimal(48),
        Decimal(1),
    );
    let before: Vec<_> = market.market.merchants.iter().map(|m| m.listings).collect();
    propose(
        &mut market,
        MerchantId::Rex,
        MerchantId::Rex,
        MerchantId::Luna,
        4,
        24,
        1,
    );
    set_accept_context("luna.testnet", 1, 1, NOW + 1);
    let result = serde_json::to_value(accept(&mut market, 1, 1)).unwrap();
    assert_eq!(result["market_revision"], "5");
    assert_eq!(
        result["data"]["trade"],
        json!({
            "trade_id":"2","kind":"merchant_trade","buyer":{"kind":"merchant","merchant_id":"rex"},
            "seller":{"kind":"merchant","merchant_id":"luna"},"resource":"crystal","quantity":"4",
            "unit_price":"6","total_price":"24","offer_id":"1","buyer_gold_after":"204","seller_gold_after":"244",
            "buyer_resource_after":"7","seller_resource_after":"8","settled_at_ns":(NOW+1).to_string(),"market_revision":"5"
        })
    );
    assert_eq!(result["data"]["offer"]["status"], "accepted");
    assert_eq!(result["data"]["offer"]["settled_trade_id"], "2");
    assert_eq!(
        result["data"]["offer"]["closed_at_ns"],
        (NOW + 1).to_string()
    );
    let canonical = r#"{"args":{"action_id":"1","offer_id":"1"},"method":"accept_trade"}"#;
    let digest: String = env::sha256_array(canonical.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        result["data"]["action"],
        json!({"action_id":"1","method":"accept_trade","args_sha256":digest,"market_revision":"5","offer_id":"1","trade_id":"2","listing_version":null})
    );
    let merchants = &market.market.merchants;
    assert_eq!(
        (
            merchants[0].listings[0].quantity,
            merchants[0].listings[0].version
        ),
        (3, 3)
    );
    assert_eq!(
        (
            merchants[1].listings[0].quantity,
            merchants[1].listings[0].version
        ),
        (8, 2)
    );
    for (merchant, original) in merchants.iter().zip(&before) {
        assert_eq!(&merchant.listings[1..], &original[1..]);
    }
    assert_eq!(merchants[2].listings, before[2]);
    assert!(merchants.iter().all(|m| m.pending_offer_count == 0));
    assert!(market.market.pending_offer_ids.iter().all(Option::is_none));
    let player = market
        .market
        .players
        .get(&"player.testnet".parse::<near_sdk::AccountId>().unwrap())
        .unwrap();
    assert_eq!(
        merchants.iter().map(|m| m.balances.gold()).sum::<u64>() + player.balances.gold(),
        650
    );
    for resource in Resource::ALL {
        assert_eq!(
            merchants
                .iter()
                .map(|m| m.balances.inventory.amount(resource))
                .sum::<u64>()
                + player.balances.inventory.amount(resource),
            market.market.resource_supply.amount(resource)
        );
    }
    assert_eq!(market.market.total_issued_gold, 650);
    assert_eq!(
        merchants[0].actions.last_action().unwrap().method,
        MerchantMethod::ProposeTrade
    );
}

#[test]
fn seller_proposer_requires_buyer_acceptance_and_ignores_changed_public_prices() {
    let mut market = market();
    propose(
        &mut market,
        MerchantId::Luna,
        MerchantId::Rex,
        MerchantId::Luna,
        4,
        24,
        1,
    );
    market.market.merchants[0].listings[0] = Listing::new(100, 0, false).unwrap();
    market.market.merchants[1].listings[0] = Listing::new(1, 0, false).unwrap();
    set_accept_context("rex.testnet", 1, 1, NOW);
    let result = accept(&mut market, 1, 1);
    assert_eq!(result.data.trade.unit_price.0, 6);
    assert_eq!(result.data.trade.total_price.0, 24);
    assert_eq!(market.market.merchants[0].balances.gold(), 156);
    assert_eq!(market.market.merchants[1].balances.gold(), 244);
    assert!(!market.market.merchants[0].listings[0].active);
    assert!(!market.market.merchants[1].listings[0].active);
    assert_eq!(market.market.merchants[0].listings[0].version, 2);
    assert_eq!(market.market.merchants[1].listings[0].version, 2);
}

#[test]
fn only_counterparty_predecessor_can_accept_unpaused_with_next_action() {
    let mut market = pending();
    for caller in [
        "rex.testnet",
        "owner.testnet",
        "market.testnet",
        "bolt.testnet",
        "proxy.testnet",
    ] {
        set_accept_context(caller, 1, 1, NOW);
        reject(&mut market, 1, 1, "BB:E_UNAUTHORIZED");
    }
    set_accept_context("luna.testnet", 1, 1, NOW);
    market.market.paused = true;
    reject(&mut market, 1, 1, "BB:E_MARKET_PAUSED");
    market.market.paused = false;
    for (action, code) in [(0, "BB:E_ACTION_USED"), (2, "BB:E_ACTION_GAP")] {
        set_accept_context("luna.testnet", 1, action, NOW);
        reject(&mut market, 1, action, code);
    }
    set_accept_context("luna.testnet", 1, 1, NOW);
    accept(&mut market, 1, 1);
    set_accept_context("luna.testnet", 1, 2, NOW);
    reject(&mut market, 1, 2, "BB:E_OFFER_ACCEPTED");
}

#[test]
fn expiry_equality_cleanup_cancellation_and_unknown_offers_cannot_settle() {
    let mut market = pending();
    set_accept_context("luna.testnet", 1, 1, 121_000_000_000);
    reject(&mut market, 1, 1, "BB:E_OFFER_EXPIRED");
    market.market.expire_offers(&[1], 121_000_000_000).unwrap();
    reject(&mut market, 1, 1, "BB:E_OFFER_EXPIRED");
    for (id, code) in [(0, "BB:E_INVALID_ARGUMENT"), (2, "BB:E_OFFER_NOT_FOUND")] {
        set_accept_context("luna.testnet", id, 1, NOW);
        reject(&mut market, id, 1, code);
    }
    market.market.offers.remove(&1);
    set_accept_context("luna.testnet", 1, 1, NOW);
    reject(&mut market, 1, 1, "BB:E_OFFER_PRUNED");
    let mut market = pending();
    market
        .market
        .close_offer(1, OfferStatus::Cancelled, NOW, None)
        .unwrap();
    set_accept_context("luna.testnet", 1, 1, NOW);
    reject(&mut market, 1, 1, "BB:E_OFFER_CANCELLED");
}

#[test]
fn balances_and_caps_are_rechecked_after_proposal_and_failed_actions_remain_usable() {
    let mut market = pending();
    let original = market
        .market
        .merchants
        .iter()
        .map(|m| m.balances)
        .collect::<Vec<_>>();
    for (index, gold, stock, code) in [
        (0, 23, 15, "BB:E_INSUFFICIENT_GOLD"),
        (1, 220, 3, "BB:E_INSUFFICIENT_STOCK"),
        (0, 180, 997, "BB:E_BALANCE_CAP"),
        (1, MAX_ACTOR_GOLD - 23, 12, "BB:E_BALANCE_CAP"),
    ] {
        market.market.merchants[index].balances =
            Balances::new(gold, Inventory::new([stock, 0, 0, 0]).unwrap()).unwrap();
        set_accept_context("luna.testnet", 1, 1, NOW);
        reject(&mut market, 1, 1, code);
        market.market.merchants[index].balances = original[index];
    }
    set_accept_context("luna.testnet", 1, 1, NOW);
    accept(&mut market, 1, 1);
    assert_eq!(market.market.merchants[1].actions.last_action_id(), 1);
}

#[test]
fn malformed_stored_terms_overflow_and_trade_collision_leave_offer_pending() {
    let mut market = pending();
    set_accept_context("luna.testnet", 1, 1, NOW);
    market.market.offers.get_mut(&1).unwrap().total_price = 23;
    reject(&mut market, 1, 1, "BB:E_INVALID_TOTAL");
    market.market.offers.get_mut(&1).unwrap().total_price = 24;
    for case in 0..4 {
        match case {
            0 => market.market.market_revision = u64::MAX,
            1 => market.market.merchants[0].listings[0].version = u64::MAX,
            2 => market.market.merchants[1].listings[0].version = u64::MAX,
            _ => market.market.trade_ids = borsh::from_slice(&u64::MAX.to_le_bytes()).unwrap(),
        }
        reject(&mut market, 1, 1, "BB:E_ARITHMETIC_OVERFLOW");
        market.market.market_revision = 2;
        market.market.merchants[0].listings[0].version = 1;
        market.market.merchants[1].listings[0].version = 1;
        market.market.trade_ids = IdSequence::default();
    }
    market.market.trades.insert(
        1,
        Trade {
            trade_id: 1,
            kind: TradeKind::MerchantTrade,
            buyer: Actor::Merchant {
                merchant_id: MerchantId::Rex,
            },
            seller: Actor::Merchant {
                merchant_id: MerchantId::Luna,
            },
            resource: Resource::Crystal,
            quantity: 4,
            unit_price: 6,
            total_price: 24,
            offer_id: Some(99),
            buyer_gold_after: 156,
            seller_gold_after: 244,
            buyer_resource_after: 19,
            seller_resource_after: 8,
            settled_at_ns: NOW,
            market_revision: 2,
        },
    );
    reject(&mut market, 1, 1, "BB:E_INVALID_ARGUMENT");
    assert_eq!(
        market.market.offers.get(&1).unwrap().status,
        OfferStatus::Pending
    );
    market.market.trades.remove(&1);
    market.market.pending_offer_ids[0] = None;
    reject(&mut market, 1, 1, "BB:E_INVALID_ARGUMENT");
    assert!(market.market.trades.get(&1).is_none());
}

#[test]
fn successful_acceptance_obeys_maximum_terms_and_deactivates_depleted_seller() {
    let mut market = market();
    market.market.merchants[0].balances =
        Balances::new(10000, Inventory::new([900, 0, 0, 0]).unwrap()).unwrap();
    market.market.merchants[1].balances = Balances::new(
        MAX_ACTOR_GOLD - 10000,
        Inventory::new([100, 0, 0, 0]).unwrap(),
    )
    .unwrap();
    market.market.merchants[1].listings[0] = Listing::new(1, 100, true).unwrap();
    propose(
        &mut market,
        MerchantId::Rex,
        MerchantId::Rex,
        MerchantId::Luna,
        100,
        10000,
        1,
    );
    set_accept_context("luna.testnet", 1, 1, 120_999_999_999);
    let result = accept(&mut market, 1, 1);
    assert_eq!(result.data.trade.buyer_gold_after.0, 0);
    assert_eq!(result.data.trade.seller_gold_after.0, MAX_ACTOR_GOLD);
    assert_eq!(result.data.trade.buyer_resource_after.0, 1000);
    assert_eq!(result.data.trade.seller_resource_after.0, 0);
    assert!(!market.market.merchants[1].listings[0].active);
    assert_eq!(market.market.merchants[1].listings[0].quantity, 0);
}

#[test]
fn terminal_offers_and_trades_roll_over_without_reopening_old_settlements() {
    let mut market = market();
    for id in 1..=101 {
        let (buyer, seller) = if id % 2 == 1 {
            (MerchantId::Rex, MerchantId::Luna)
        } else {
            (MerchantId::Luna, MerchantId::Rex)
        };
        propose(&mut market, MerchantId::Rex, buyer, seller, 1, 1, id);
        set_accept_context("luna.testnet", id, id, NOW);
        accept(&mut market, id, id);
    }
    assert_eq!(market.market.terminal_offer_ids.count, 100);
    assert_eq!(market.market.trade_history_ids.count, 100);
    assert!(market.market.offers.get(&1).is_none());
    assert!(market.market.trades.get(&1).is_none());
    assert_eq!(market.market.offers_pruned_through, 1);
    assert_eq!(market.market.trades_pruned_through, 1);
    assert_eq!(market.market.offer_ids.next_id(), 102);
    assert_eq!(market.market.trade_ids.next_id(), 102);
    set_accept_context("luna.testnet", 1, 102, NOW);
    reject(&mut market, 1, 102, "BB:E_OFFER_PRUNED");
    assert_eq!(market.market.merchants[0].actions.last_action_id(), 101);
    assert_eq!(market.market.merchants[1].actions.last_action_id(), 101);
}
