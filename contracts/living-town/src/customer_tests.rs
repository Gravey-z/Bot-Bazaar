use super::*;
use crate::production::tests::{context, start, town};
fn command(seq: u64) -> Command {
    Command {
        sequence: Decimal(seq),
        config_version: Decimal(1),
        valid_until_ns: Decimal(env::block_timestamp() + 300_000_000_000),
    }
}
fn epoch(t: &LivingTown, e: u64) {
    context(
        "operator.testnet",
        json!({}),
        t.genesis_time_ns + e * 60_000_000_000 + 1,
    );
}
fn fund(t: &mut LivingTown, e: u64, seq: u64) -> Value {
    let time = env::block_timestamp();
    let c = command(seq);
    context(
        "operator.testnet",
        json!({"epoch":e.to_string(),"command":c}),
        time,
    );
    t.fund_customer_budget(Decimal(e), c)
}
fn buy(
    t: &mut LivingTown,
    target: (&str, u64),
    revision: u64,
    e: u64,
    cap: u64,
    seq: u64,
) -> Value {
    let time = env::block_timestamp();
    let c = command(seq);
    context(
        target.0,
        json!({"listing_id":target.1.to_string(),"expected_listing_revision":revision.to_string(),"epoch":e.to_string(),"max_total_price":cap.to_string(),"command":c}),
        time,
    );
    t.settle_customer_purchase(
        Decimal(target.1),
        Decimal(revision),
        Decimal(e),
        Decimal(cap),
        c,
    )
}
fn stocked() -> LivingTown {
    let mut t = town();
    start(&mut t, 3, 3);
    let ready = t.jobs.get(&1).unwrap().terms.ready_at_ns;
    context("keeper.testnet", json!({"job_id":"1"}), ready);
    t.complete_production(Decimal(1));
    // Controlled native tool inventory; actual WASM proof crafts both recipes.
    t.players
        .get_mut(&"player.testnet".parse::<AccountId>().unwrap())
        .unwrap()
        .inventory
        .quantities[5] = 3;
    for (seq, item, price) in [(4, Item::HealthPotion, 18), (5, Item::IronTool, 24)] {
        let time = env::block_timestamp();
        let c = command(seq);
        context(
            "player.testnet",
            json!({"shop_id":"4","item_id":item,"quantity":"3","unit_price":price.to_string(),"expected_listing_revision":null,"command":c}),
            time,
        );
        t.set_listing(Decimal(4), item, Decimal(3), Decimal(price), None, c);
    }
    t
}
fn state(t: &LivingTown) -> Value {
    let player = t
        .players
        .get(&"player.testnet".parse::<AccountId>().unwrap())
        .unwrap();
    let rows = [5, 6].map(|id| {
        t.listing_row(id)
            .map(|(_, _, row)| near_sdk::borsh::to_vec(&row).unwrap())
    });
    json!({"root":near_sdk::borsh::to_vec(t).unwrap(),"ledger":player.ledger(),"listings":rows,"operator":t.commands.get(&"account:operator.testnet".to_owned()).map(|r|near_sdk::borsh::to_vec(r).unwrap()),"trade":t.trades.get(&1).map(|r|near_sdk::borsh::to_vec(r).unwrap())})
}
#[test]
fn funding_is_once_per_current_epoch_including_zero_and_survives_reopen() {
    let mut t = town();
    let before = state(&t);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fund(&mut t, 0, 1))).is_err());
    assert_eq!(state(&t), before);
    epoch(&t, 1);
    let first = fund(&mut t, 1, 1);
    assert_eq!(t.customer_pool.gold, 200);
    assert_eq!(t.customer_topups, 100);
    let before = state(&t);
    assert_eq!(
        fund(&mut t, 1, 1)["data"]["outcome"],
        first["data"]["outcome"]
    );
    assert_eq!(state(&t), before);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fund(&mut t, 1, 2))).is_err());
    assert_eq!(state(&t), before);
    epoch(&t, 2);
    let zero = fund(&mut t, 2, 2);
    assert_eq!(zero["data"]["outcome"]["issued_gold"], "0");
    assert_eq!(t.customer_topups, 100);
    let bytes = near_sdk::borsh::to_vec(&t).unwrap();
    drop(t);
    let mut t: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
    let before = state(&t);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fund(&mut t, 2, 3))).is_err());
    assert_eq!(state(&t), before);
    t.customer_pool.gold = 190;
    epoch(&t, 20);
    let partial = fund(&mut t, 20, 3);
    assert_eq!(partial["data"]["outcome"]["issued_gold"], "10");
    assert_eq!(t.customer_topups, 110);
    assert_eq!(t.customer_pool.last_funded, 20);
}
#[test]
fn product_quotas_and_sink_debits_are_global_bounded_and_epoch_local() {
    let mut t = stocked();
    let e = t.customer_epoch();
    for (seq, id, revision, cap) in [(1, 5, 1, 18), (2, 5, 2, 18), (3, 6, 1, 24), (4, 6, 2, 24)] {
        buy(&mut t, ("operator.testnet", id), revision, e, cap, seq);
    }
    assert_eq!(t.customer_pool.gold, 16);
    assert_eq!(t.customer_pool.counts, [2, 2]);
    assert_eq!(t.customer_consumed, [0, 0, 0, 0, 2, 2]);
    let p = t
        .players
        .get(&"player.testnet".parse::<AccountId>().unwrap())
        .unwrap();
    assert_eq!(p.gold, 184);
    assert_eq!(p.inventory.quantities[4..], [1, 1]);
    assert_eq!(p.reservations.listing.quantities[4..], [1, 1]);
    let before = state(&t);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(
            &mut t,
            ("operator.testnet", 5),
            3,
            e,
            18,
            5
        )))
        .is_err()
    );
    assert_eq!(state(&t), before);
    epoch(&t, e + 1);
    assert_eq!(t.customer_pool.view(e + 1)["potion_units_bought"], "0");
    let before = state(&t);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(
            &mut t,
            ("operator.testnet", 5),
            3,
            e + 1,
            18,
            5
        )))
        .is_err()
    );
    assert_eq!(state(&t), before);
    fund(&mut t, e + 1, 5);
    let sale = buy(&mut t, ("operator.testnet", 5), 3, e + 1, 18, 6);
    assert_eq!(sale["data"]["outcome"]["trade"]["consumed_quantity"], "1");
    assert_eq!(t.customer_pool.counts, [1, 0]);
    assert_eq!(t.customer_pool.gold, 98);
    let before = state(&t);
    assert_eq!(
        buy(&mut t, ("operator.testnet", 5), 3, e + 1, 18, 6)["data"]["replayed"],
        true
    );
    assert_eq!(state(&t), before);
}
#[test]
fn customer_failures_leave_pool_seller_stock_markers_and_commands_unchanged() {
    let mut t = stocked();
    let e = t.customer_epoch();
    let original_player = t
        .players
        .get(&"player.testnet".parse::<AccountId>().unwrap())
        .unwrap()
        .clone();
    let original_pool = t.customer_pool.clone();
    let original_listing = t.player_listings.get(&5).unwrap().clone();
    for case in 0..10 {
        t.players
            .insert(original_player.account_id.clone(), original_player.clone());
        t.customer_pool = original_pool.clone();
        t.player_listings.insert(5, original_listing.clone());
        t.customer_consumed = [0; 6];
        match case {
            0 => t.customer_pool.gold = 0,
            1 => t.players.get_mut(&original_player.account_id).unwrap().gold = 999_990,
            2 => t.player_listings.get_mut(&5).unwrap().unit_price = 100,
            3 => t.customer_pool.revision = u64::MAX,
            4 => t.customer_consumed[4] = u128::MAX,
            _ => {}
        }
        let (actor, id, rev, claimed, cap) = match case {
            5 => ("player.testnet", 5, 1, e, 18),
            6 => ("operator.testnet", 1, 1, e, 18),
            7 => ("operator.testnet", 5, 2, e, 18),
            8 => ("operator.testnet", 5, 1, e + 1, 18),
            9 => ("operator.testnet", 5, 1, e, 17),
            _ => ("operator.testnet", 5, 1, e, 100),
        };
        let before = state(&t);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(
                &mut t,
                (actor, id),
                rev,
                claimed,
                cap,
                1
            )))
            .is_err()
        );
        assert_eq!(state(&t), before, "case {case}");
    }
}
#[test]
fn pause_and_epoch_markers_cannot_be_bypassed_with_another_command_sequence() {
    let mut t = stocked();
    let e = t.customer_epoch();
    fund(&mut t, e, 1);
    t.paused = true;
    let before = state(&t);
    assert_eq!(fund(&mut t, e, 1)["data"]["replayed"], true);
    assert_eq!(state(&t), before);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(
            &mut t,
            ("operator.testnet", 5),
            1,
            e,
            18,
            2
        )))
        .is_err()
    );
    assert_eq!(state(&t), before);
    t.paused = false;
    let before = state(&t);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fund(&mut t, e, 2))).is_err());
    assert_eq!(state(&t), before);
    let bytes = near_sdk::borsh::to_vec(&t).unwrap();
    drop(t);
    let mut t: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
    assert_eq!(t.customer_pool.last_funded, e);
    buy(&mut t, ("operator.testnet", 5), 1, e, 18, 2);
    assert_eq!(t.customer_pool.gold, 182);
}

#[test]
fn sale_cancel_and_reprice_conflicts_are_safe_in_both_execution_orders() {
    // Deterministic order coverage complements the independently submitted WASM races.
    for cancel in [true, false] {
        for owner_first in [true, false] {
            near_sdk::mock::with_mocked_blockchain(|b| {
                b.take_storage();
            });
            let mut t = stocked();
            let e = t.customer_epoch();
            let time = env::block_timestamp();
            let edit = |t: &mut LivingTown, revision: u64| {
                let c = command(6);
                if cancel {
                    context(
                        "player.testnet",
                        json!({"listing_id":"5","expected_listing_revision":revision.to_string(),"command":c}),
                        time,
                    );
                    t.cancel_listing(Decimal(5), Decimal(revision), c)
                } else {
                    context(
                        "player.testnet",
                        json!({"shop_id":"4","item_id":"health_potion","quantity":"3","unit_price":"17","expected_listing_revision":revision.to_string(),"command":c}),
                        time,
                    );
                    t.set_listing(
                        Decimal(4),
                        Item::HealthPotion,
                        Decimal(3),
                        Decimal(17),
                        Some(Decimal(revision)),
                        c,
                    )
                }
            };
            if owner_first {
                edit(&mut t, 1);
                let before = state(&t);
                assert!(
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(
                        &mut t,
                        ("operator.testnet", 5),
                        1,
                        e,
                        18,
                        1
                    )))
                    .is_err()
                );
                assert_eq!(state(&t), before);
                assert_eq!(t.customer_pool.gold, 100);
                assert_eq!(t.customer_consumed[4], 0);
                if !cancel {
                    buy(&mut t, ("operator.testnet", 5), 2, e, 18, 1);
                    assert_eq!(t.customer_pool.gold, 83);
                    assert_eq!(t.customer_consumed[4], 1);
                }
            } else {
                buy(&mut t, ("operator.testnet", 5), 1, e, 18, 1);
                let before = state(&t);
                assert!(
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| edit(&mut t, 1)))
                        .is_err()
                );
                assert_eq!(state(&t), before);
                assert_eq!(t.customer_pool.gold, 82);
                assert_eq!(t.customer_consumed[4], 1);
                if cancel {
                    edit(&mut t, 2);
                }
            }
            let p = t
                .players
                .get(&"player.testnet".parse::<AccountId>().unwrap())
                .unwrap();
            let l = t.listing_row(5).unwrap().2;
            assert_eq!(p.reservations.listing.quantities[4], l.quantity);
            assert_eq!(p.inventory.quantities[4] + t.customer_consumed[4] as u64, 3);
        }
    }
}
