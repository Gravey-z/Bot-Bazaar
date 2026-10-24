use super::*;
use crate::{MerchantControllers, initialization::initialized_state, state::*};
use near_sdk::{
    AccountId, borsh,
    serde_json::{self, Value, json},
    test_utils::VMContextBuilder,
    testing_env,
};

#[test]
fn a_purchase_rolls_over_full_trade_history_without_extra_asset_changes() {
    let mut market = market();
    let mut input = args();
    context("player.testnet", &input);
    buy(&mut market, &input);
    let first = borsh::to_vec(market.market.trades.get(&1).unwrap()).unwrap();
    for id in 2..=100 {
        let mut trade: Trade = borsh::from_slice(&first).unwrap();
        trade.trade_id = id;
        market.market.append_trade(trade).unwrap();
    }
    market.market.trades.flush();
    input["quantity"] = json!("3");
    input["max_total_price"] = json!("12");
    input["listing_version"] = json!("2");
    context("player.testnet", &input);
    let result = buy(&mut market, &input);
    assert_eq!(result.data.trade_id.0, 101);
    assert_eq!(result.data.buyer_gold_after.0, 40);
    assert_eq!(result.data.seller_gold_after.0, 240);
    assert_eq!(market.market.trades_pruned_through, 1);
    assert_eq!(market.market.trade_history_ids.count, 100);
    assert_eq!(market.market.trade_ids.next_id(), 102);
    market.market.players.flush();
    market.market.trades.flush();
    let state: MarketState = borsh::from_slice(&borsh::to_vec(&market.market).unwrap()).unwrap();
    assert!(state.trades.get(&1).is_none());
    assert!(state.trades.get(&2).is_some());
    assert!(state.trades.get(&101).is_some());
    assert_eq!(
        state
            .players
            .get(&account("player.testnet"))
            .unwrap()
            .balances
            .gold(),
        40
    );
}

fn account(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn context(predecessor: &str, args: &Value) {
    let mut context = VMContextBuilder::new()
        .current_account_id(account("market.testnet"))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account("player.testnet"))
        .block_height(42)
        .block_timestamp(1000)
        .build();
    context.input = serde_json::to_vec(args).unwrap().into();
    testing_env!(context);
}

fn market() -> Market {
    near_sdk::mock::with_mocked_blockchain(|blockchain| {
        blockchain.take_storage();
    });
    context("player.testnet", &json!({}));
    let mut market = Market {
        market: initialized_state(
            account("owner.testnet"),
            MerchantControllers {
                rex: account("rex.testnet"),
                luna: account("luna.testnet"),
                bolt: account("bolt.testnet"),
            },
            &account("market.testnet"),
        )
        .unwrap(),
    };
    market.register_player();
    market
}

fn args() -> Value {
    json!({"merchant_id":"rex","resource":"crystal","quantity":"12","max_total_price":"48","listing_version":"1"})
}

fn buy(market: &mut Market, args: &Value) -> Snapshot<TradeView> {
    market.buy_from_merchant(
        serde_json::from_value(args["merchant_id"].clone()).unwrap(),
        serde_json::from_value(args["resource"].clone()).unwrap(),
        serde_json::from_value(args["quantity"].clone()).unwrap(),
        serde_json::from_value(args["max_total_price"].clone()).unwrap(),
        serde_json::from_value(args["listing_version"].clone()).unwrap(),
    )
}

fn snapshot(market: &Market) -> Vec<Vec<u8>> {
    let mut values = vec![
        borsh::to_vec(&market.market).unwrap(),
        borsh::to_vec(
            market
                .market
                .players
                .get(&account("player.testnet"))
                .unwrap(),
        )
        .unwrap(),
    ];
    for id in 1..=120 {
        if let Some(trade) = market.market.trades.get(&id) {
            values.push(borsh::to_vec(trade).unwrap());
        }
    }
    values
}

fn reject(market: &mut Market, args: &Value, code: &str) {
    let before = snapshot(market);
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(market, args)))
        .err()
        .unwrap();
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap_or("");
    assert!(message.contains(code), "{message}");
    assert_eq!(snapshot(market), before);
}

#[test]
fn purchase_matches_the_12_crystal_fixture_and_conserves_all_assets() {
    let mut market = market();
    let other_merchants: Vec<_> = market.market.merchants[1..]
        .iter()
        .map(|m| borsh::to_vec(m).unwrap())
        .collect();
    let args = args();
    context("player.testnet", &args);
    let result = serde_json::to_value(buy(&mut market, &args)).unwrap();
    assert_eq!(
        result,
        json!({
            "market_revision":"3","block_height":"42","block_timestamp_ns":"1000",
            "data":{"trade_id":"1","kind":"player_purchase","buyer":{"kind":"player","account_id":"player.testnet"},
                "seller":{"kind":"merchant","merchant_id":"rex"},"resource":"crystal","quantity":"12","unit_price":"4","total_price":"48",
                "offer_id":null,"buyer_gold_after":"52","seller_gold_after":"228","buyer_resource_after":"12","seller_resource_after":"3",
                "settled_at_ns":"1000","market_revision":"3"}
        })
    );
    let player = market
        .market
        .players
        .get(&account("player.testnet"))
        .unwrap();
    assert_eq!(
        player.balances.gold()
            + market
                .market
                .merchants
                .iter()
                .map(|m| m.balances.gold())
                .sum::<u64>(),
        650
    );
    for resource in Resource::ALL {
        assert_eq!(
            player.balances.inventory.amount(resource)
                + market
                    .market
                    .merchants
                    .iter()
                    .map(|m| m.balances.inventory.amount(resource))
                    .sum::<u64>(),
            market.market.resource_supply.amount(resource)
        );
    }
    let listing = market.market.merchants[0].listings[0];
    assert_eq!(
        (listing.quantity, listing.version, listing.active),
        (3, 2, true)
    );
    assert_eq!(market.market.trade_ids.next_id(), 2);
    assert_eq!(market.market.trade_history_ids.count, 1);
    assert_eq!(market.market.offer_ids.next_id(), 1);
    assert_eq!(market.market.registered_player_count, 1);
    assert_eq!(market.market.total_issued_gold, 650);
    assert!(
        market
            .market
            .merchants
            .iter()
            .all(|m| m.actions.last_action_id() == 0)
    );
    for (merchant, bytes) in market.market.merchants[1..].iter().zip(other_merchants) {
        assert_eq!(borsh::to_vec(merchant).unwrap(), bytes);
    }
}

#[test]
fn purchases_deplete_listings_once_and_reject_stale_or_inactive_retries() {
    let mut market = market();
    let original = args();
    context("player.testnet", &original);
    buy(&mut market, &original);
    reject(&mut market, &original, "BB:E_STALE_LISTING");
    let mut remainder = original.clone();
    remainder["quantity"] = json!("3");
    remainder["max_total_price"] = json!("12");
    remainder["listing_version"] = json!("2");
    context("player.testnet", &remainder);
    buy(&mut market, &remainder);
    let listing = market.market.merchants[0].listings[0];
    assert_eq!(
        (listing.quantity, listing.version, listing.active),
        (0, 3, false)
    );
    assert_eq!(market.market.trade_ids.next_id(), 3);
    assert_eq!(market.market.market_revision, 4);
    let mut inactive = remainder;
    inactive["quantity"] = json!("1");
    inactive["listing_version"] = json!("3");
    context("player.testnet", &inactive);
    reject(&mut market, &inactive, "BB:E_LISTING_INACTIVE");
}

#[test]
fn invalid_bounds_and_quote_limits_preserve_player_merchant_and_history_state() {
    let mut market = market();
    for (field, value, code) in [
        ("quantity", "0", "BB:E_INVALID_QUANTITY"),
        ("quantity", "101", "BB:E_INVALID_QUANTITY"),
        ("quantity", "18446744073709551615", "BB:E_INVALID_QUANTITY"),
        ("max_total_price", "0", "BB:E_INVALID_TOTAL"),
        ("max_total_price", "10001", "BB:E_INVALID_TOTAL"),
        ("max_total_price", "47", "BB:E_INVALID_TOTAL"),
        ("listing_version", "0", "BB:E_STALE_LISTING"),
        ("quantity", "16", "BB:E_INSUFFICIENT_LISTED_QUANTITY"),
    ] {
        let mut input = args();
        input[field] = json!(value);
        context("player.testnet", &input);
        reject(&mut market, &input, code);
    }
    let mut inactive = args();
    inactive["resource"] = json!("herb");
    inactive["quantity"] = json!("1");
    context("player.testnet", &inactive);
    reject(&mut market, &inactive, "BB:E_LISTING_INACTIVE");
    let input = args();
    context("proxy.testnet", &input);
    reject(&mut market, &input, "BB:E_NOT_REGISTERED");
    context("player.testnet", &input);
    market.market.paused = true;
    reject(&mut market, &input, "BB:E_MARKET_PAUSED");
}

#[test]
fn insufficient_assets_and_resulting_balance_caps_fail_without_partial_transfers() {
    for scenario in 0..4 {
        let mut market = market();
        let input = args();
        context("player.testnet", &input);
        match scenario {
            0 => {
                market
                    .market
                    .players
                    .get_mut(&account("player.testnet"))
                    .unwrap()
                    .balances = Balances::new(47, Inventory::default()).unwrap()
            }
            1 => {
                market.market.merchants[0].balances.inventory =
                    Inventory::new([1, 4, 2, 10]).unwrap()
            }
            2 => {
                market
                    .market
                    .players
                    .get_mut(&account("player.testnet"))
                    .unwrap()
                    .balances
                    .inventory = Inventory::new([MAX_ACTOR_RESOURCE, 0, 0, 0]).unwrap()
            }
            _ => {
                market.market.merchants[0].balances = Balances::new(
                    MAX_ACTOR_GOLD,
                    market.market.merchants[0].balances.inventory,
                )
                .unwrap()
            }
        }
        reject(
            &mut market,
            &input,
            [
                "BB:E_INSUFFICIENT_GOLD",
                "BB:E_INSUFFICIENT_STOCK",
                "BB:E_BALANCE_CAP",
                "BB:E_BALANCE_CAP",
            ][scenario],
        );
    }
}

#[test]
fn version_revision_id_overflow_and_trade_collision_leave_all_ledgers_unchanged() {
    for scenario in 0..3 {
        let mut market = market();
        let mut input = args();
        match scenario {
            0 => market.market.market_revision = u64::MAX,
            1 => {
                market.market.merchants[0].listings[0].version = u64::MAX;
                input["listing_version"] = json!(u64::MAX.to_string());
            }
            _ => market.market.trade_ids = borsh::from_slice(&u64::MAX.to_le_bytes()).unwrap(),
        }
        context("player.testnet", &input);
        reject(&mut market, &input, "BB:E_ARITHMETIC_OVERFLOW");
    }
    let mut market = market();
    let mut input = args();
    context("player.testnet", &input);
    buy(&mut market, &input);
    market.market.trade_ids = borsh::from_slice(&1_u64.to_le_bytes()).unwrap();
    input["quantity"] = json!("1");
    input["listing_version"] = json!("2");
    context("player.testnet", &input);
    reject(&mut market, &input, "BB:E_INVALID_ARGUMENT");
}

#[test]
fn maximum_quantity_total_and_actor_caps_are_inclusive() {
    let mut market = market();
    market
        .market
        .players
        .get_mut(&account("player.testnet"))
        .unwrap()
        .balances = Balances::new(10000, Inventory::new([900, 0, 0, 0]).unwrap()).unwrap();
    market.market.merchants[0].balances = Balances::new(
        MAX_ACTOR_GOLD - 10000,
        Inventory::new([100, 4, 2, 10]).unwrap(),
    )
    .unwrap();
    market.market.merchants[0].listings[0] = Listing::new(100, 100, true).unwrap();
    let input = json!({"merchant_id":"rex","resource":"crystal","quantity":"100","max_total_price":"10000","listing_version":"1"});
    context("player.testnet", &input);
    let result = buy(&mut market, &input);
    assert_eq!(result.data.total_price.0, 10000);
    assert_eq!(result.data.buyer_gold_after.0, 0);
    assert_eq!(result.data.seller_gold_after.0, MAX_ACTOR_GOLD);
    assert_eq!(result.data.buyer_resource_after.0, MAX_ACTOR_RESOURCE);
    assert_eq!(result.data.seller_resource_after.0, 0);
}
