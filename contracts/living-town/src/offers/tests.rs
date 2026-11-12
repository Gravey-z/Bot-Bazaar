use super::*;
fn town() -> LivingTown {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    crate::production::tests::town()
}

// Carry storage usage across simulated receipts. The general test helper resets
// the VM's usage baseline; doing that here would invalidate cumulative sizing.
fn context(actor: &str, payload: Value, time: u64) {
    let used = env::storage_usage();
    let mut c = near_sdk::test_utils::VMContextBuilder::new()
        .current_account_id("town.testnet".parse().unwrap())
        .predecessor_account_id(actor.parse().unwrap())
        .signer_account_id(actor.parse().unwrap())
        .account_balance(near_sdk::NearToken::from_near(1000))
        .storage_usage(used)
        .block_timestamp(time)
        .build();
    c.input = serde_json::to_vec(&payload).unwrap().into();
    near_sdk::testing_env!(c);
}

fn command(t: &LivingTown, m: usize, now: u64) -> Command {
    let seq = t
        .commands
        .get(&format!("merchant:{}", MERCHANTS[m]))
        .map_or(1, |r| r.sequence + 1);
    Command {
        sequence: Decimal(seq),
        config_version: Decimal(t.config_version),
        valid_until_ns: Decimal(now + 500_000_000_000),
    }
}
fn proposal(
    t: &LivingTown,
    b: MerchantId,
    s: MerchantId,
    item: Item,
    q: u64,
    price: u64,
    now: u64,
) -> Value {
    json!({"buyer_merchant_id":b,"seller_merchant_id":s,"item_id":item,"quantity":q.to_string(),"unit_price":price.to_string(),"expires_at_ns":(now+600_000_000_000).to_string(),"expected_buyer_ledger_revision":t.npcs[b as usize].ledger_revision.to_string(),"expected_seller_ledger_revision":t.npcs[s as usize].ledger_revision.to_string(),"command":command(t,b as usize,now)})
}
fn propose(t: &mut LivingTown, p: Value, actor: &str, now: u64) -> Value {
    context(actor, p.clone(), now);
    let a: ProposeArgs = serde_json::from_value(p).unwrap();
    t.propose_trade(
        a.buyer_merchant_id,
        a.seller_merchant_id,
        a.item_id,
        a.quantity,
        a.unit_price,
        a.expires_at_ns,
        a.expected_buyer_ledger_revision,
        a.expected_seller_ledger_revision,
        a.command,
    )
}
fn accept(t: &mut LivingTown, id: u64, now: u64) -> Value {
    let o = t.offers.get(&id).unwrap().clone();
    let m = o.seller as usize;
    let c = command(t, m, now);
    let p = json!({"merchant_id":MERCHANTS[m],"offer_id":id.to_string(),"expected_offer_revision":o.revision.to_string(),"expected_buyer_ledger_revision":t.npcs[o.buyer as usize].ledger_revision.to_string(),"expected_seller_ledger_revision":t.npcs[m].ledger_revision.to_string(),"command":c});
    context(&format!("{}.testnet", MERCHANTS[m]), p, now);
    t.accept_trade(
        [MerchantId::Rex, MerchantId::Luna, MerchantId::Bolt][m],
        Decimal(id),
        Decimal(o.revision),
        Decimal(t.npcs[o.buyer as usize].ledger_revision),
        Decimal(t.npcs[m].ledger_revision),
        c,
    )
}
fn release(t: &mut LivingTown, id: u64, kind: Kind, now: u64) -> Value {
    let o = t.offers.get(&id).unwrap().clone();
    let m = if matches!(kind, Kind::Rejected) {
        o.seller
    } else {
        o.buyer
    } as usize;
    let c = command(t, m, now);
    let p = json!({"merchant_id":MERCHANTS[m],"offer_id":id.to_string(),"expected_offer_revision":o.revision.to_string(),"command":c});
    context(&format!("{}.testnet", MERCHANTS[m]), p, now);
    t.close_offer(
        [MerchantId::Rex, MerchantId::Luna, MerchantId::Bolt][m],
        Decimal(id),
        Decimal(o.revision),
        c,
        kind,
    )
}
fn expire(t: &mut LivingTown, m: usize, ids: Vec<u64>, now: u64) -> Value {
    let c = command(t, m, now);
    let ids: Vec<_> = ids.into_iter().map(Decimal).collect();
    context(
        &format!("{}.testnet", MERCHANTS[m]),
        json!({"merchant_id":MERCHANTS[m],"offer_ids":ids,"command":c}),
        now,
    );
    t.expire_offers(
        [MerchantId::Rex, MerchantId::Luna, MerchantId::Bolt][m],
        ids,
        c,
    )
}
fn fails(t: &mut LivingTown, f: impl FnOnce(&mut LivingTown)) {
    let before = near_sdk::borsh::to_vec(t).unwrap();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(t))).is_err());
    assert_eq!(before, near_sdk::borsh::to_vec(t).unwrap());
}

fn distributed_town() -> LivingTown {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    let digest = config_digest();
    context(
        "town.testnet",
        json!({"owner_account_id":"owner.testnet","operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest}),
        1,
    );
    LivingTown::initialize_town(
        "owner.testnet".parse().unwrap(),
        Controllers {
            rex: "rex.testnet".parse().unwrap(),
            luna: "luna.testnet".parse().unwrap(),
            bolt: "bolt.testnet".parse().unwrap(),
        },
        "operator.testnet".parse().unwrap(),
        "11111111111111111111111111111111".to_owned(),
        digest,
    )
}
fn distributed_purchase(t: &mut LivingTown) {
    let c = Command {
        sequence: Decimal(1),
        config_version: Decimal(1),
        valid_until_ns: Decimal(500_000_000_000),
    };
    context("player.testnet", json!({"command":c}), 2);
    t.register_player(c.clone());
    let c = Command {
        sequence: Decimal(2),
        ..c
    };
    context(
        "player.testnet",
        json!({"merchant_id":"rex","item_id":"crystal","quantity":"8","expected_listing_revision":"1","max_total_price":"32","command":c}),
        3,
    );
    t.buy_from_merchant(
        MerchantId::Rex,
        Item::Crystal,
        Decimal(8),
        Decimal(1),
        Decimal(32),
        c,
    );
}

#[test]
fn distributed_initial_ownership_and_accounting_are_explicit() {
    let t = distributed_town();
    assert_eq!(t.config_version, 1);
    assert_eq!(t.npcs[0].held.quantities, [12, 4, 7, 7, 0, 0]);
    assert_eq!(t.npcs[1].held.quantities, [4, 7, 12, 4, 0, 0]);
    assert_eq!(t.npcs[2].held.quantities, [7, 12, 4, 12, 0, 0]);
    for (slot, primary) in PRIMARY.iter().enumerate() {
        assert_eq!(
            t.npcs.iter().map(|n| n.held.quantities[slot]).sum::<u64>(),
            23
        );
        for m in 0..3 {
            assert_eq!(t.npcs[m].listings[slot].is_some(), *primary == m);
        }
    }
    assert_eq!(t.town()["totals"]["seed_items"]["herb"], "23");
    context("town.testnet", json!({}), 2);
    assert_eq!(t.get_merchant_trading_rules()["data"]["backup_cap"], "7");
}

#[test]
fn distributed_player_demand_can_trade_preowned_stock_without_bootstrap_and_seller_can_refuse() {
    let mut t = distributed_town();
    distributed_purchase(&mut t);
    let p = proposal(
        &t,
        MerchantId::Rex,
        MerchantId::Luna,
        Item::Crystal,
        2,
        5,
        10,
    );
    propose(&mut t, p, "rex.testnet", 10);
    let before = (t.npcs[0].gold, t.npcs[1].gold);
    release(&mut t, 1, Kind::Rejected, 11);
    assert_eq!((t.npcs[0].gold, t.npcs[1].gold), before);
    assert_eq!(t.npcs[1].held.quantities[0], 4);
    assert_eq!(t.npcs[0].reservations.gold_trade, 0);
    let p = proposal(
        &t,
        MerchantId::Rex,
        MerchantId::Luna,
        Item::Crystal,
        2,
        5,
        12,
    );
    propose(&mut t, p, "rex.testnet", 12);
    accept(&mut t, 2, 13);
    assert_eq!(
        (
            t.npcs[0].held.quantities[0],
            t.npcs[1].held.quantities[0],
            t.npcs[2].held.quantities[0]
        ),
        (6, 2, 7)
    );
    assert_eq!((t.npcs[0].gold, t.npcs[1].gold), (222, 210));
    assert_eq!(
        t.npcs.iter().map(|n| n.held.quantities[0]).sum::<u64>() + 8,
        23
    );
    let p = proposal(
        &t,
        MerchantId::Rex,
        MerchantId::Luna,
        Item::Crystal,
        1,
        5,
        14,
    );
    fails(&mut t, |t| {
        propose(t, p, "rex.testnet", 14);
    });
}

#[test]
fn distributed_seven_unit_capacity_includes_incoming_and_preserves_peer_floor() {
    let mut t = distributed_town();
    // Test a six-unit peer; a second pending unit must count toward its cap.
    t.npcs[1].held.quantities[0] = 6;
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 10);
    });
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        1,
        4,
        11,
    );
    propose(&mut t, p, "luna.testnet", 11);
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        1,
        4,
        12,
    );
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 12);
    });
    release(&mut t, 1, Kind::Cancelled, 13);
    assert_eq!(t.npcs[1].held.quantities[0], 6);
    assert_eq!(t.npcs[1].reservations.inbound.quantities[0], 0);
}

#[test]
fn distributed_sources_are_slow_bounded_and_do_not_catch_up_or_fill_promised_space() {
    let mut t = distributed_town();
    distributed_purchase(&mut t);
    for (epoch, sequence, expected) in [(1, 1, 4), (5, 2, 6), (1000, 3, 8)] {
        let c = Command {
            sequence: Decimal(sequence),
            config_version: Decimal(1),
            valid_until_ns: Decimal(epoch * 60_000_000_000 + 500_000_000_001),
        };
        context(
            "operator.testnet",
            json!({"item_id":"crystal","epoch":epoch.to_string(),"command":c}),
            epoch * 60_000_000_000 + 1,
        );
        t.allocate_raw_supply(Item::Crystal, Decimal(epoch), c, None);
        assert_eq!(t.npcs[0].held.quantities[0], expected);
    }
    t.npcs[0].reservations.inbound.quantities[0] = 4;
    let c = Command {
        sequence: Decimal(4),
        config_version: Decimal(1),
        valid_until_ns: Decimal(1005 * 60_000_000_000 + 500_000_000_001),
    };
    context(
        "operator.testnet",
        json!({"item_id":"crystal","epoch":"1005","command":c}),
        1005 * 60_000_000_000 + 1,
    );
    t.allocate_raw_supply(Item::Crystal, Decimal(1005), c, None);
    assert_eq!(t.npcs[0].held.quantities[0], 8);
    assert_eq!(t.supplied_items[0], 4);
    assert_eq!(t.npcs[1].held.quantities[0], 4);
}

#[test]
fn distributed_herb_shortage_still_halves_the_slow_source() {
    let mut t = distributed_town();
    t.npcs[1].held.quantities[2] = 4;
    t.npcs[1].listings[2].as_mut().unwrap().quantity = 0;
    // Controlled scheduled event; no inventory is granted by the event itself.
    t.market_events.push_back(market_events::MarketEvent {
        id: 1,
        start: 5,
        end: 10,
        revision: 1,
    });
    for (epoch, sequence, expected) in [(5, 1, 5), (10, 2, 7)] {
        let c = Command {
            sequence: Decimal(sequence),
            config_version: Decimal(1),
            valid_until_ns: Decimal(epoch * 60_000_000_000 + 500_000_000_001),
        };
        context(
            "operator.testnet",
            json!({"item_id":"herb","epoch":epoch.to_string(),"command":c}),
            epoch * 60_000_000_000 + 1,
        );
        t.allocate_raw_supply(Item::Herb, Decimal(epoch), c, None);
        assert_eq!(t.npcs[1].held.quantities[2], expected);
    }
    assert_eq!(t.supplied_items[2], 3);
}

#[test]
fn reserve_topup_requires_listing_release_and_independent_controller_then_conserves_assets() {
    let mut t = town();
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    let effect = propose(&mut t, p.clone(), "luna.testnet", 10);
    assert_eq!(effect["data"]["principal"], "merchant:luna");
    assert_eq!(t.npcs[1].gold, 200);
    assert_eq!(t.npcs[1].reservations.gold_trade, 8);
    assert_eq!(t.npcs[0].ledger_revision, 1);
    fails(&mut t, |t| {
        accept(t, 1, 11);
    });
    let c = command(&t, 0, 12);
    context(
        "rex.testnet",
        json!({"shop_id":"1","item_id":"crystal","quantity":"6","unit_price":"4","expected_listing_revision":"1","command":c}),
        12,
    );
    t.set_listing(
        Decimal(1),
        Item::Crystal,
        Decimal(6),
        Decimal(4),
        Some(Decimal(1)),
        c,
    );
    let r = accept(&mut t, 1, 13);
    assert_eq!(r["data"]["principal"], "merchant:rex");
    assert_eq!(r["data"]["outcome"]["trade"]["kind"], "merchant_trade");
    assert_eq!(r["data"]["outcome"]["trade"]["listing_id"], Value::Null);
    assert_eq!((t.npcs[0].gold, t.npcs[1].gold), (208, 192));
    assert_eq!(
        (t.npcs[0].held.quantities[0], t.npcs[1].held.quantities[0]),
        (10, 6)
    );
    assert_eq!(t.npcs[1].reservations.gold_trade, 0);
    assert_eq!(t.npcs[1].reservations.inbound.quantities[0], 0);
    assert_eq!(t.npcs.iter().map(|n| n.gold).sum::<u64>(), 600);
    assert_eq!(t.npcs.iter().map(|n| n.held.quantities[0]).sum::<u64>(), 23);
    assert_eq!(t.next_trade_id, 2);
    assert_eq!(t.offers.get(&1).unwrap().status.name(), "accepted");
}

#[test]
fn proposal_guards_and_replay_preserve_original_effect_even_after_deadline() {
    let mut t = town();
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    fails(&mut t, |t| {
        propose(t, p.clone(), "player.testnet", 10);
    });
    for (key, value) in [
        ("quantity", "3"),
        ("unit_price", "7"),
        ("expected_buyer_ledger_revision", "99"),
        ("expires_at_ns", "50"),
    ] {
        let mut bad = p.clone();
        bad[key] = json!(value);
        fails(&mut t, |t| {
            propose(t, bad, "luna.testnet", 10);
        });
    }
    let r = propose(&mut t, p.clone(), "luna.testnet", 10);
    let rev = t.market_revision;
    let replay = propose(&mut t, p, "luna.testnet", 700_000_000_000);
    assert_eq!(replay["data"]["replayed"], true);
    assert_eq!(replay["data"]["outcome"], r["data"]["outcome"]);
    assert_eq!(t.market_revision, rev);
    assert_eq!(t.pending_offers, vec![1]);
    assert_eq!(
        t.offers.get(&1).unwrap().view(700_000_000_000)["expired"],
        true
    );
}

#[test]
fn rejection_cancellation_and_expiry_release_only_buyer_promises_while_paused() {
    let mut t = town();
    for kind in [Kind::Rejected, Kind::Cancelled] {
        let id = t.next_offer_id;
        let p = proposal(
            &t,
            MerchantId::Luna,
            MerchantId::Rex,
            Item::Crystal,
            2,
            4,
            10,
        );
        propose(&mut t, p, "luna.testnet", 10);
        t.paused = true;
        release(&mut t, id, kind, 11);
        assert_eq!(t.npcs[1].gold, 200);
        assert_eq!(t.npcs[1].reservations.gold_trade, 0);
        assert_eq!(t.npcs[1].reservations.inbound.quantities[0], 0);
        t.paused = false;
    }
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        20,
    );
    propose(&mut t, p, "luna.testnet", 20);
    t.paused = true;
    fails(&mut t, |t| {
        expire(t, 1, vec![3, 3], 600_000_000_020);
    });
    fails(&mut t, |t| {
        expire(t, 1, vec![3], 100);
    });
    let r = expire(&mut t, 1, vec![3, 1, 2], 600_000_000_020);
    assert_eq!(r["data"]["outcome"]["offers"].as_array().unwrap().len(), 1);
    assert_eq!(r["data"]["outcome"]["skipped_offer_ids"], json!(["1", "2"]));
    assert_eq!(t.pending_offer_counts, [0; 3]);
    assert!(t.pending_offers.is_empty());
    assert_eq!(t.npcs[1].reservations.gold_trade, 0);
    expire(&mut t, 1, vec![3], 600_000_000_021);
    assert_eq!(t.npcs[1].gold, 200);
}

#[test]
fn incoming_capacity_limits_backup_admission_and_source_target_headroom() {
    let mut t = town();
    t.npcs[0].held.quantities[0] = 10;
    t.npcs[0].listings[0].as_mut().unwrap().quantity = 8;
    t.npcs[1].held.quantities[0] = 4;
    let p = proposal(
        &t,
        MerchantId::Rex,
        MerchantId::Luna,
        Item::Crystal,
        2,
        5,
        10,
    );
    propose(&mut t, p, "rex.testnet", 10);
    let c = Command {
        sequence: Decimal(1),
        config_version: Decimal(1),
        valid_until_ns: Decimal(500_000_000_000),
    };
    context(
        "operator.testnet",
        json!({"item_id":"crystal","epoch":"5","command":c}),
        300_000_000_001,
    );
    t.allocate_raw_supply(Item::Crystal, Decimal(5), c, None);
    assert_eq!(t.npcs[0].held.quantities[0], 10);
    assert_eq!(t.supplied_items[0], 0);
    let p = proposal(
        &t,
        MerchantId::Rex,
        MerchantId::Luna,
        Item::Crystal,
        1,
        5,
        300_000_000_002,
    );
    fails(&mut t, |t| {
        propose(t, p, "rex.testnet", 60_000_000_002);
    });
    accept(&mut t, 1, 300_000_000_003);
    assert_eq!(t.npcs[0].held.quantities[0], 12);
    assert_eq!(t.npcs[1].held.quantities[0], 2);
}

#[test]
fn closure_retention_never_prunes_old_pending_and_pages_disclose_gaps() {
    let mut t = town();
    let base_storage = env::storage_usage();
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        1,
        4,
        10,
    );
    propose(&mut t, p, "luna.testnet", 10);
    for _ in 0..130 {
        let id = t.next_offer_id;
        let p = proposal(
            &t,
            MerchantId::Luna,
            MerchantId::Rex,
            Item::Crystal,
            1,
            4,
            10,
        );
        propose(&mut t, p, "luna.testnet", 10);
        release(&mut t, id, Kind::Rejected, 11);
    }
    assert_eq!(t.closed_offers.len(), 128);
    assert_eq!(t.pending_offers, vec![1]);
    assert!(t.offers.get(&1).is_some());
    assert!(t.offers.get(&2).is_none());
    assert_eq!(t.pruned_offer_through, 3);
    let p = json!({"merchant_id":null,"status":"pending","after_id":null,"limit":"50","expected_market_revision":t.market_revision.to_string()});
    context("viewer.testnet", p, 12);
    let page = t.get_offers(
        None,
        "pending".to_owned(),
        None,
        Decimal(50),
        Decimal(t.market_revision),
    );
    assert_eq!(page["data"]["history_gap"], true);
    assert_eq!(page["data"]["items"][0]["offer_id"], "1");
    // Fill the remaining slots while the 128 terminal records remain retained.
    // These synthetic holdings exercise the storage bound, not seed accounting.
    t.npcs[0].held.quantities[0] = 2;
    t.npcs[0].listings[0].as_mut().unwrap().quantity = 0;
    t.npcs[1].held.quantities[0] = 5;
    t.npcs[2].held.quantities[0] = 6;
    t.npcs[1].held.quantities[2] = 8;
    t.npcs[1].listings[2].as_mut().unwrap().quantity = 0;
    t.npcs[2].held.quantities[2] = 6;
    for (s, count) in [(MerchantId::Luna, 3), (MerchantId::Bolt, 4)] {
        for _ in 0..count {
            let p = proposal(&t, MerchantId::Rex, s, Item::Crystal, 1, 4, 20);
            propose(&mut t, p, "rex.testnet", 20);
        }
    }
    for _ in 0..4 {
        let p = proposal(&t, MerchantId::Luna, MerchantId::Bolt, Item::Herb, 1, 3, 20);
        propose(&mut t, p, "luna.testnet", 20);
    }
    assert_eq!(t.closed_offers.len() + t.pending_offers.len(), 140);
    assert_eq!(t.pending_offer_counts, [8, 8, 8]);
    assert!(
        (10_000..=65_536).contains(&(env::storage_usage() - base_storage)),
        "cumulative storage must include all retained offer records"
    );
    save_measurement(
        "merchant-offer-storage-bound.json",
        json!({"source":"native near-sdk storage accounting; synthetic bounded holdings; code bytes excluded","pending":12,"terminal":128,"total_offer_records":140,"baseline_storage_bytes":base_storage,"peak_storage_bytes":env::storage_usage(),"additional_storage_bytes":env::storage_usage()-base_storage,"additional_stake_yoctonear":(u128::from(env::storage_usage()-base_storage)*env::storage_byte_cost().as_yoctonear()).to_string()}),
    );
}

fn save_measurement(name: &str, value: Value) {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/living-town-captures");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join(name),
        serde_json::to_string_pretty(&value).unwrap(),
    )
    .unwrap();
}

#[test]
fn pending_caps_and_worst_case_result_sizes_are_bounded() {
    let mut t = town();
    t.npcs[0].held.quantities[0] = 2;
    t.npcs[0].listings[0].as_mut().unwrap().quantity = 0;
    t.npcs[1].held.quantities[0] = 6;
    t.npcs[2].held.quantities[0] = 6;
    t.npcs[1].held.quantities[2] = 8;
    t.npcs[1].listings[2].as_mut().unwrap().quantity = 0;
    t.npcs[2].held.quantities[2] = 6;
    for s in [MerchantId::Luna, MerchantId::Bolt] {
        for _ in 0..4 {
            let p = proposal(&t, MerchantId::Rex, s, Item::Crystal, 1, 4, 10);
            propose(&mut t, p, "rex.testnet", 10);
        }
    }
    for _ in 0..4 {
        let p = proposal(&t, MerchantId::Luna, MerchantId::Bolt, Item::Herb, 1, 3, 10);
        propose(&mut t, p, "luna.testnet", 10);
    }
    assert_eq!(t.pending_offer_counts, [8, 8, 8]);
    assert_eq!(t.pending_offers.len(), 12);
    let p = proposal(&t, MerchantId::Luna, MerchantId::Bolt, Item::Herb, 1, 3, 10);
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 10);
    });
    let offers: Vec<_> = t
        .pending_offers
        .iter()
        .map(|id| {
            let mut o = t.offers.get(id).unwrap().clone();
            o.status = Status::Expired;
            o.revision = u64::MAX;
            o.closed_at = Some(u64::MAX);
            o.closing_merchant = Some(2);
            o.closing_sequence = Some(u64::MAX);
            o
        })
        .collect();
    let mut ledgers: Vec<_> = t
        .npcs
        .iter()
        .enumerate()
        .map(|(i, n)| (i as u8, n.clone()))
        .collect();
    for (_, n) in &mut ledgers {
        n.held = Inventory::new([900; 6]);
        n.gold = 1_000_000;
        for l in &mut n.listings {
            *l = Some(Listing {
                id: u64::MAX,
                quantity: 100,
                unit_price: 100,
                revision: u64::MAX,
            });
        }
    }
    let e = Effect {
        actor: 0,
        kind: Kind::Expired,
        offers,
        ledgers,
        trade: None,
        skipped: (100..112).collect(),
        at: 600_000_000_010,
    };
    let record = ownership::CommandRecord {
        sequence: u64::MAX,
        digest: [255; 32],
        revision: u64::MAX,
        outcome: Outcome::MerchantOffer(Box::new(e.clone())),
    };
    let compact = near_sdk::borsh::to_vec(&record).unwrap().len();
    let json_size = serde_json::to_vec(&e.view()).unwrap().len();
    assert!(compact <= 4096, "compact {compact}");
    assert!(json_size <= 32768, "json {json_size}");
    println!("MT-001 conservative result bytes: borsh={compact}, json={json_size}");
    let mut callable = e.clone();
    callable.offers.truncate(8);
    callable.skipped = (100..116).collect();
    let callable_bytes =
        near_sdk::borsh::to_vec(&Outcome::MerchantOffer(Box::new(callable.clone())))
            .unwrap()
            .len()
            + 48;
    assert!(callable_bytes <= 4096);
    assert!(serde_json::to_vec(&callable.view()).unwrap().len() <= 32768);
    let skipped = Effect {
        actor: 0,
        kind: Kind::Expired,
        offers: vec![],
        ledgers: vec![],
        trade: None,
        skipped: vec![u64::MAX; 24],
        at: u64::MAX,
    };
    assert!(near_sdk::borsh::to_vec(&skipped).unwrap().len() + 49 <= 4096);
    assert!(serde_json::to_vec(&skipped.view()).unwrap().len() <= 32768);
    save_measurement(
        "merchant-offer-result-bounds.json",
        json!({"source":"native conservative serialization bounds, not chain transactions","conservative_12_offer_3_ledger_borsh_record_bytes":compact,"conservative_12_offer_3_ledger_json_bytes":json_size,"callable_8_offer_16_skip_borsh_record_bytes":callable_bytes,"callable_8_offer_16_skip_json_bytes":serde_json::to_vec(&callable.view()).unwrap().len(),"all_24_skipped_borsh_record_bytes":near_sdk::borsh::to_vec(&skipped).unwrap().len()+49,"all_24_skipped_json_bytes":serde_json::to_vec(&skipped.view()).unwrap().len(),"borsh_cap":4096,"json_cap":32768}),
    );
    expire(&mut t, 0, (1..=8).collect(), 600_000_000_010);
    expire(&mut t, 1, (9..=12).collect(), 600_000_000_010);
    assert_eq!(t.pending_offer_counts, [0; 3]);
    assert!(t.npcs.iter().all(|n| n.reservations.gold_trade == 0));
}

#[test]
fn gold_capacity_direction_and_competing_promises_reject_without_side_effects() {
    let mut t = town();
    t.npcs[1].held.quantities[0] = 5;
    let mut p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    p["seller_merchant_id"] = json!("luna");
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 10);
    });
    let previous = t.npcs[2].held.quantities[0];
    t.npcs[2].held.quantities[0] = 1;

    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Bolt,
        Item::Crystal,
        2,
        4,
        10,
    );
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 10);
    });

    t.npcs[2].held.quantities[0] = previous;
    t.npcs[1].gold = 120;
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 10);
    });
    t.npcs[1].gold = 200;
    t.npcs[0].gold = 999_996;
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 10);
    });
    t.npcs[0].gold = 200;
    t.npcs[1].reservations.output.quantities[0] = 999;
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 10);
    });
    t.npcs[1].reservations.output.quantities[0] = 0;
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        2,
        4,
        10,
    );
    propose(&mut t, p, "luna.testnet", 10);
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        1,
        4,
        11,
    );
    fails(&mut t, |t| {
        propose(t, p, "luna.testnet", 11);
    });
    fails(&mut t, |t| {
        expire(t, 2, vec![1], 600_000_000_010);
    });
}

#[test]
fn expiry_batch_with_an_unexpired_later_offer_does_not_partially_release() {
    let mut t = town();
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        1,
        4,
        10,
    );
    propose(&mut t, p, "luna.testnet", 10);
    let p = proposal(
        &t,
        MerchantId::Luna,
        MerchantId::Rex,
        Item::Crystal,
        1,
        4,
        100_000_000_000,
    );
    propose(&mut t, p, "luna.testnet", 100_000_000_000);
    fails(&mut t, |t| {
        expire(t, 1, vec![1, 2], 650_000_000_000);
    });
    assert_eq!(t.npcs[1].reservations.gold_trade, 8);
    expire(&mut t, 1, vec![1], 650_000_000_000);
    assert_eq!(t.npcs[1].reservations.gold_trade, 4);
    assert_eq!(t.pending_offers, vec![2]);
}
