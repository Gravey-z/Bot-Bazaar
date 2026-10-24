use super::*;
use crate::initialization::{MerchantControllers, initialized_state};
use near_sdk::{
    borsh,
    serde_json::{self, json},
    test_utils::VMContextBuilder,
    testing_env,
};

fn context(input: serde_json::Value, now: u64) {
    let mut context = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .block_height(42)
        .block_timestamp(now)
        .build();
    context.input = serde_json::to_vec(&input).unwrap().into();
    testing_env!(context);
}

fn market() -> Market {
    context(json!({}), 100);
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

fn offer(id: u64, status: OfferStatus, expiry: u64) -> Offer {
    Offer {
        offer_id: id,
        proposer: MerchantId::Rex,
        buyer: MerchantId::Rex,
        seller: MerchantId::Luna,
        counterparty: MerchantId::Luna,
        resource: Resource::Crystal,
        quantity: 2,
        unit_price: 4,
        total_price: 8,
        created_at_ns: 1,
        expires_at_ns: expiry,
        status,
        closed_at_ns: (status != OfferStatus::Pending).then_some(50),
        settled_trade_id: (status == OfferStatus::Accepted).then_some(1),
        proposal_action: ActionRef {
            merchant_id: MerchantId::Rex,
            action_id: id,
        },
    }
}

fn trade(id: u64) -> Trade {
    Trade {
        trade_id: id,
        kind: TradeKind::PlayerPurchase,
        buyer: Actor::Player {
            account_id: "player.testnet".parse().unwrap(),
        },
        seller: Actor::Merchant {
            merchant_id: MerchantId::Rex,
        },
        resource: Resource::Crystal,
        quantity: 2,
        unit_price: 4,
        total_price: 8,
        offer_id: None,
        buyer_gold_after: 92,
        seller_gold_after: 188,
        buyer_resource_after: 2,
        seller_resource_after: 13,
        settled_at_ns: 75,
        market_revision: id,
    }
}

fn offer_args(status: &str, after: serde_json::Value, limit: &str) -> serde_json::Value {
    json!({"merchant_id":"rex","status":status,"after_id":after,"limit":limit,"expected_revision":"1"})
}

#[test]
fn market_and_actor_views_match_wire_shapes_and_preserve_state() {
    let mut market = market();
    market.market.paused = true;
    market.market.players.insert(
        "player.testnet".parse().unwrap(),
        Player {
            account_id: "player.testnet".parse().unwrap(),
            balances: Balances::new(100, Inventory::default()).unwrap(),
        },
    );
    market.market.merchants[0]
        .actions
        .record(LastAction {
            action_id: 1,
            method: MerchantMethod::SetListing,
            args_sha256: [0xab; 32],
            market_revision: 1,
            offer_id: None,
            trade_id: None,
            listing_version: Some(2),
        })
        .unwrap();
    let before = borsh::to_vec(&market.market).unwrap();
    let snapshot = serde_json::to_value(market.get_market_state()).unwrap();
    assert_eq!(snapshot["market_revision"], "1");
    assert_eq!(snapshot["block_height"], "42");
    assert_eq!(snapshot["block_timestamp_ns"], "100");
    let data = &snapshot["data"];
    assert_eq!(data["api_version"], "1.0.0");
    assert_eq!(data["economy_version"], "1");
    assert_eq!(data["contract_account_id"], "market.testnet");
    assert_eq!(data["owner_account_id"], "owner.testnet");
    assert_eq!(data["paused"], true);
    assert_eq!(data["total_issued_gold"], "550");
    assert_eq!(
        data["resource_supply"],
        json!({"crystal":"29","wood":"25","herb":"26","iron":"24"})
    );
    assert_eq!(data["limits"]["max_page_size"], "50");
    assert_eq!(data["limits"]["retained_trade_limit"], "100");
    assert_eq!(data["merchants"].as_array().unwrap().len(), 3);
    for (index, id) in ["rex", "luna", "bolt"].iter().enumerate() {
        let merchant = &data["merchants"][index];
        assert_eq!(merchant["merchant_id"], *id);
        for (slot, resource) in ["crystal", "wood", "herb", "iron"].iter().enumerate() {
            assert_eq!(merchant["listings"][slot]["resource"], *resource);
            assert_eq!(merchant["listings"][slot]["merchant_id"], *id);
        }
        context(json!({"merchant_id":id}), 100);
        assert_eq!(
            serde_json::to_value(market.get_merchant(MerchantId::ALL[index])).unwrap()["data"],
            *merchant
        );
    }
    assert_eq!(
        data["merchants"][0]["last_action"]["args_sha256"],
        "ab".repeat(32)
    );
    assert_eq!(data["merchants"][0]["last_action"]["method"], "set_listing");
    assert_eq!(data["merchants"][1]["last_action"], serde_json::Value::Null);
    context(json!({"account_id":"player.testnet"}), 100);
    let player =
        serde_json::to_value(market.get_player("player.testnet".parse().unwrap())).unwrap();
    assert_eq!(
        player["data"],
        json!({"account_id":"player.testnet","gold":"100","inventory":{"crystal":"0","wood":"0","herb":"0","iron":"0"}})
    );
    context(json!({"account_id":"missing.testnet"}), 100);
    assert!(
        market
            .get_player("missing.testnet".parse().unwrap())
            .data
            .is_none()
    );
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
}

#[test]
fn offers_report_effective_expiry_and_distinguish_pruned_from_unknown() {
    let mut market = market();
    for _ in 0..4 {
        market.market.offer_ids.allocate().unwrap();
    }
    market
        .market
        .offers
        .insert(2, offer(2, OfferStatus::Pending, 100));
    market
        .market
        .offers
        .insert(3, offer(3, OfferStatus::Accepted, 80));
    let before = borsh::to_vec(market.market.offers.get(&2).unwrap()).unwrap();
    for (now, status, closed) in [
        (99, "pending", json!(null)),
        (100, "expired", json!("100")),
        (101, "expired", json!("100")),
    ] {
        context(json!({"offer_id":"2"}), now);
        let value = serde_json::to_value(market.get_offer(Decimal(2))).unwrap();
        assert_eq!(value["data"]["kind"], "found");
        assert_eq!(value["data"]["offer"]["status"], status);
        assert_eq!(value["data"]["offer"]["closed_at_ns"], closed);
    }
    context(json!({"offer_id":"3"}), 100);
    let accepted = serde_json::to_value(market.get_offer(Decimal(3))).unwrap();
    assert_eq!(accepted["data"]["offer"]["status"], "accepted");
    assert_eq!(accepted["data"]["offer"]["settled_trade_id"], "1");
    context(json!({"offer_id":"1"}), 100);
    assert!(matches!(
        market.get_offer(Decimal(1)).data,
        OfferLookup::Pruned { .. }
    ));
    context(json!({"offer_id":"5"}), 100);
    assert!(matches!(
        market.get_offer(Decimal(5)).data,
        OfferLookup::NotFound { .. }
    ));
    assert_eq!(
        borsh::to_vec(market.market.offers.get(&2).unwrap()).unwrap(),
        before
    );
}

#[test]
fn offer_pages_sort_filter_and_preserve_live_rows_below_pruning_watermark() {
    let mut market = market();
    market.market.paused = true;
    market.market.offers_pruned_through = 10;
    for (slot, id, status, expiry) in [
        (0, 11, OfferStatus::Pending, 101),
        (1, 2, OfferStatus::Pending, 100),
        (2, 1, OfferStatus::Pending, 200),
    ] {
        market.market.pending_offer_ids[slot] = Some(id);
        market.market.offers.insert(id, offer(id, status, expiry));
    }
    market.market.terminal_offer_ids.slots[99] = Some(12);
    market.market.terminal_offer_ids.head = 99;
    market.market.terminal_offer_ids.count = 1;
    market
        .market
        .offers
        .insert(12, offer(12, OfferStatus::Cancelled, 200));
    let before = borsh::to_vec(&market.market).unwrap();
    context(offer_args("all", json!(null), "2"), 100);
    let first = market
        .get_offers_for_merchant(
            MerchantId::Rex,
            OfferFilter::All,
            None,
            Decimal(2),
            Some(Decimal(1)),
        )
        .data;
    assert_eq!(
        first
            .items
            .iter()
            .map(|row| row.offer_id.0)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(first.has_more && first.history_gap);
    assert_eq!(first.next_after_id.unwrap().0, 2);
    context(offer_args("all", json!("2"), "2"), 100);
    let second = market
        .get_offers_for_merchant(
            MerchantId::Rex,
            OfferFilter::All,
            Some(Decimal(2)),
            Decimal(2),
            None,
        )
        .data;
    assert_eq!(
        second
            .items
            .iter()
            .map(|row| row.offer_id.0)
            .collect::<Vec<_>>(),
        [11, 12]
    );
    assert!(!second.has_more);
    context(offer_args("pending", json!(null), "50"), 100);
    let pending = market
        .get_offers_for_merchant(
            MerchantId::Rex,
            OfferFilter::Pending,
            None,
            Decimal(50),
            None,
        )
        .data;
    assert_eq!(
        pending
            .items
            .iter()
            .map(|row| row.offer_id.0)
            .collect::<Vec<_>>(),
        [1, 11]
    );
    context(offer_args("terminal", json!(null), "50"), 100);
    let terminal = market
        .get_offers_for_merchant(
            MerchantId::Luna,
            OfferFilter::Terminal,
            None,
            Decimal(50),
            None,
        )
        .data;
    assert_eq!(
        terminal
            .items
            .iter()
            .map(|row| row.offer_id.0)
            .collect::<Vec<_>>(),
        [2, 12]
    );
    let unrelated = market
        .get_offers_for_merchant(MerchantId::Bolt, OfferFilter::All, None, Decimal(50), None)
        .data;
    assert!(unrelated.items.is_empty() && unrelated.history_gap);
    context(offer_args("all", json!("12"), "50"), 100);
    let end = market
        .get_offers_for_merchant(
            MerchantId::Rex,
            OfferFilter::All,
            Some(Decimal(12)),
            Decimal(50),
            None,
        )
        .data;
    assert!(end.items.is_empty() && !end.has_more && !end.history_gap);
    assert_eq!(end.next_after_id.unwrap().0, 12);
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
}

#[test]
fn full_indexes_use_numeric_pagination_with_limits_and_gap_metadata() {
    let mut market = market();
    market.market.trade_history_ids.count = RETAINED_HISTORY as u8;
    market.market.trade_history_ids.head = 37;
    market.market.terminal_offer_ids.count = RETAINED_HISTORY as u8;
    market.market.terminal_offer_ids.head = 71;
    for slot in 0..RETAINED_HISTORY {
        let id = 200 - slot as u64;
        market.market.trade_history_ids.slots[slot] = Some(id);
        market.market.trades.insert(id, trade(id));
        market.market.terminal_offer_ids.slots[slot] = Some(id);
        market
            .market
            .offers
            .insert(id, offer(id, OfferStatus::Accepted, 80));
    }
    for slot in 0..MAX_PENDING_OFFERS {
        let id = slot as u64 + 1;
        market.market.pending_offer_ids[slot] = Some(id);
        market
            .market
            .offers
            .insert(id, offer(id, OfferStatus::Pending, 80));
    }
    market.market.trades_pruned_through = 100;
    context(
        json!({"after_id":null,"limit":"50","expected_revision":null}),
        100,
    );
    let first = market.get_recent_trades(None, Decimal(50), None).data;
    assert_eq!(first.items.len(), 50);
    assert_eq!(first.items.first().unwrap().trade_id.0, 101);
    assert_eq!(first.items.last().unwrap().trade_id.0, 150);
    assert!(first.has_more && first.history_gap);
    let wire = serde_json::to_value(&first.items[0]).unwrap();
    assert_eq!(wire["kind"], "player_purchase");
    assert_eq!(
        wire["buyer"],
        json!({"kind":"player","account_id":"player.testnet"})
    );
    assert_eq!(
        wire["seller"],
        json!({"kind":"merchant","merchant_id":"rex"})
    );
    assert!(wire["offer_id"].is_null());
    context(
        json!({"after_id":"150","limit":"50","expected_revision":"1"}),
        100,
    );
    let second = market
        .get_recent_trades(Some(Decimal(150)), Decimal(50), Some(Decimal(1)))
        .data;
    assert_eq!(second.items.len(), 50);
    assert!(!second.has_more && !second.history_gap);
    assert_eq!(second.items.last().unwrap().trade_id.0, 200);
    context(offer_args("terminal", json!(null), "50"), 100);
    let offers = market
        .get_offers_for_merchant(
            MerchantId::Rex,
            OfferFilter::Terminal,
            None,
            Decimal(50),
            None,
        )
        .data;
    assert_eq!(offers.items.len(), 50);
    assert_eq!(offers.items[0].offer_id.0, 1);
    assert_eq!(offers.items[12].offer_id.0, 101);
    assert!(offers.has_more);
}

#[test]
fn strict_view_inputs_reject_ambiguous_shapes_and_noncanonical_numbers() {
    for input in [
        r#"{}"#,
        r#"{"limit":"1"}"#,
        r#"{"limit":"1","after_id":null,"expected_revision":null,"extra":"x"}"#,
        r#"{"limit":"1","after_id":null,"expected_revision":null,"limit":"2"}"#,
        r#"["1",null,null]"#,
        r#"{"limit":1,"after_id":null,"expected_revision":null}"#,
    ] {
        assert!(!input::valid_input(
            input.as_bytes(),
            &["limit", "after_id", "expected_revision"]
        ));
    }
    assert!(input::valid_input(
        br#"{"limit":"1","after_id":null,"expected_revision":null}"#,
        &["limit", "after_id", "expected_revision"]
    ));
    assert!(input::valid_input(b"{}", &[]));
    for value in [
        json!(0),
        json!(1.5),
        json!("-1"),
        json!("+1"),
        json!("01"),
        json!(" 1"),
        json!("1 "),
        json!(""),
        json!("18446744073709551616"),
        json!(null),
    ] {
        assert!(serde_json::from_value::<Decimal>(value).is_err());
    }
    assert_eq!(serde_json::from_value::<Decimal>(json!("0")).unwrap().0, 0);
    assert_eq!(
        serde_json::from_value::<Decimal>(json!("18446744073709551615"))
            .unwrap()
            .0,
        u64::MAX
    );
    assert_eq!(
        serde_json::to_value(U64(u64::MAX)).unwrap(),
        "18446744073709551615"
    );
}

#[test]
#[should_panic(expected = "BB:E_INVALID_PAGE")]
fn zero_page_limit_is_rejected() {
    let market = market();
    market.validate_page(Decimal(0), None);
}

#[test]
#[should_panic(expected = "BB:E_INVALID_PAGE")]
fn oversized_page_limit_is_rejected() {
    let market = market();
    market.validate_page(Decimal(51), None);
}

#[test]
#[should_panic(expected = "BB:E_STALE_SNAPSHOT")]
fn stale_revision_is_rejected() {
    let market = market();
    market.validate_page(Decimal(1), Some(Decimal(2)));
}
