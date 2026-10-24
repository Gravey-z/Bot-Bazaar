use super::*;
use crate::initialization::{MerchantControllers, initialized_state};
use near_sdk::{NearToken, borsh, env, test_utils::VMContextBuilder, testing_env};

#[test]
fn pause_blocks_economic_storage_changes_but_allows_cancellation_and_expiry() {
    let mut state = state();
    for id in 1..=3 {
        state
            .insert_pending_offer(offer(id, MerchantId::Rex, MerchantId::Luna, 100))
            .unwrap();
    }
    state.paused = true;
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.add_player("player.testnet".parse().unwrap()),
        Err(StateError::MarketPaused)
    );
    assert_eq!(
        state.insert_pending_offer(offer(4, MerchantId::Luna, MerchantId::Bolt, 100)),
        Err(StateError::MarketPaused)
    );
    assert_eq!(state.append_trade(trade(1)), Err(StateError::MarketPaused));
    assert_eq!(
        state.close_offer(1, OfferStatus::Accepted, 99, Some(1)),
        Err(StateError::MarketPaused)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert!(
        state
            .players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .is_none()
    );
    assert!(state.trades.get(&1).is_none());
    assert!(state.offers.get(&4).is_none());
    assert_eq!(state.offers.get(&1).unwrap().status, OfferStatus::Pending);
    state
        .close_offer(1, OfferStatus::Cancelled, 99, None)
        .unwrap();
    assert_eq!(state.offers.get(&1).unwrap().closed_at_ns, Some(99));
    assert_eq!(
        state.expire_offers(&[2, 3], 100).unwrap(),
        (vec![2, 3], vec![])
    );
    assert!(state.paused);
    assert!(
        state
            .merchants
            .iter()
            .all(|merchant| merchant.pending_offer_count == 0)
    );
    state.paused = false;
    state.add_player("player.testnet".parse().unwrap()).unwrap();
    state
        .insert_pending_offer(offer(4, MerchantId::Rex, MerchantId::Bolt, 200))
        .unwrap();
    state.append_trade(trade(1)).unwrap();
    state
        .close_offer(4, OfferStatus::Accepted, 100, Some(1))
        .unwrap();
}

#[test]
fn allocation_and_issuance_overflow_leave_storage_unchanged() {
    let mut state = state();
    state.total_issued_gold = u64::MAX;
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.add_player("new.testnet".parse().unwrap()),
        Err(StateError::Overflow)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert!(
        !state
            .players
            .contains_key(&"new.testnet".parse::<AccountId>().unwrap())
    );
    state.offer_ids = IdSequence { next_id: u64::MAX };
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.insert_pending_offer(offer(u64::MAX, MerchantId::Rex, MerchantId::Luna, 10)),
        Err(StateError::Overflow)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert!(!state.offers.contains_key(&u64::MAX));
    state.trade_ids = IdSequence { next_id: u64::MAX };
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.append_trade(trade(u64::MAX)),
        Err(StateError::Overflow)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert!(!state.trades.contains_key(&u64::MAX));
}

fn state() -> MarketState {
    testing_env!(VMContextBuilder::new().build());
    initialized_state(
        "owner.testnet".parse().unwrap(),
        MerchantControllers {
            rex: "rex.testnet".parse().unwrap(),
            luna: "luna.testnet".parse().unwrap(),
            bolt: "bolt.testnet".parse().unwrap(),
        },
        &"market.testnet".parse().unwrap(),
    )
    .unwrap()
}

fn offer(id: u64, buyer: MerchantId, seller: MerchantId, deadline: u64) -> Offer {
    Offer {
        offer_id: id,
        proposer: buyer,
        buyer,
        seller,
        counterparty: seller,
        resource: Resource::Crystal,
        quantity: 1,
        unit_price: 1,
        total_price: 1,
        created_at_ns: 0,
        expires_at_ns: deadline,
        status: OfferStatus::Pending,
        closed_at_ns: None,
        settled_trade_id: None,
        proposal_action: ActionRef {
            merchant_id: buyer,
            action_id: id,
        },
    }
}

fn trade(id: u64) -> Trade {
    Trade {
        trade_id: id,
        kind: TradeKind::MerchantTrade,
        buyer: Actor::Merchant {
            merchant_id: MerchantId::Rex,
        },
        seller: Actor::Merchant {
            merchant_id: MerchantId::Luna,
        },
        resource: Resource::Crystal,
        quantity: 1,
        unit_price: 1,
        total_price: 1,
        offer_id: Some(id),
        buyer_gold_after: 179,
        seller_gold_after: 221,
        buyer_resource_after: 16,
        seller_resource_after: 11,
        settled_at_ns: 1,
        market_revision: id,
    }
}

#[test]
fn permanent_players_reject_duplicates_and_the_1001st_grant_without_changes() {
    let mut state = state();
    for id in 0..MAX_PLAYERS {
        state
            .add_player(format!("{id:064}").parse().unwrap())
            .unwrap();
    }
    assert_eq!(state.registered_player_count, MAX_PLAYERS);
    assert_eq!(state.total_issued_gold, 100_550);
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.add_player(format!("{:064}", 0).parse().unwrap()),
        Err(StateError::AlreadyRegistered)
    );
    assert_eq!(
        state.add_player(format!("{:064}", 1000).parse().unwrap()),
        Err(StateError::PlayerCapacity)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert!(
        !state
            .players
            .contains_key(&format!("{:064}", 1000).parse::<AccountId>().unwrap())
    );
    assert_eq!(
        state
            .players
            .get(&format!("{:064}", 0).parse::<AccountId>().unwrap())
            .unwrap()
            .balances
            .gold(),
        100
    );
    state.players.flush();
    env::state_write(&state);
    drop(state);
    let mut state: MarketState = env::state_read().unwrap();
    assert_eq!(
        state.add_player(format!("{:064}", 0).parse().unwrap()),
        Err(StateError::AlreadyRegistered)
    );
}

#[test]
fn pending_capacity_counts_both_participants_and_expiry_does_not_free_slots_implicitly() {
    let mut state = state();
    for (buyer, seller) in [
        (MerchantId::Rex, MerchantId::Luna),
        (MerchantId::Rex, MerchantId::Bolt),
        (MerchantId::Luna, MerchantId::Bolt),
    ] {
        for _ in 0..4 {
            let id = state.offer_ids.next_id();
            state
                .insert_pending_offer(offer(id, buyer, seller, 10))
                .unwrap();
        }
    }
    assert!(
        state
            .merchants
            .iter()
            .all(|merchant| merchant.pending_offer_count == 8)
    );
    assert_eq!(state.pending_offer_ids.iter().flatten().count(), 12);
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.insert_pending_offer(offer(13, MerchantId::Rex, MerchantId::Luna, 10)),
        Err(StateError::OfferCapacity)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert_eq!(state.expire_offers(&[1], 10).unwrap(), (vec![1], vec![]));
    assert_eq!(
        state
            .merchants
            .iter()
            .map(|merchant| merchant.pending_offer_count)
            .collect::<Vec<_>>(),
        [7, 7, 8]
    );
    state
        .insert_pending_offer(offer(13, MerchantId::Rex, MerchantId::Luna, 20))
        .unwrap();
    assert_eq!(state.offer_ids.next_id(), 14);
    assert_eq!(state.expire_offers(&[1], 11).unwrap(), (vec![], vec![1]));
    assert!(
        state
            .merchants
            .iter()
            .all(|merchant| merchant.pending_offer_count == 8)
    );
}

#[test]
fn one_full_participant_blocks_offers_even_with_free_global_slots() {
    let mut state = state();
    for id in 1..=8 {
        state
            .insert_pending_offer(offer(id, MerchantId::Rex, MerchantId::Luna, 10))
            .unwrap();
    }
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.insert_pending_offer(offer(9, MerchantId::Rex, MerchantId::Bolt, 10)),
        Err(StateError::OfferCapacity)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert_eq!(state.pending_offer_ids.iter().flatten().count(), 8);
}

#[test]
fn expiry_is_ordered_atomic_repeatable_and_advances_revision_once() {
    let mut state = state();
    for (id, deadline) in [(1, 100), (2, 101), (3, 99)] {
        state
            .insert_pending_offer(offer(id, MerchantId::Rex, MerchantId::Luna, deadline))
            .unwrap();
    }
    let before = borsh::to_vec(&state).unwrap();
    for invalid in [vec![], vec![1, 1], vec![1, 0], (1..=25).collect()] {
        assert_eq!(
            state.expire_offers(&invalid, 100),
            Err(StateError::InvalidBatch)
        );
        assert_eq!(borsh::to_vec(&state).unwrap(), before);
        assert_eq!(state.offers.get(&1).unwrap().status, OfferStatus::Pending);
    }
    state.market_revision = u64::MAX;
    assert_eq!(state.expire_offers(&[1], 100), Err(StateError::Overflow));
    assert_eq!(state.offers.get(&1).unwrap().status, OfferStatus::Pending);
    state.market_revision = 1;
    assert_eq!(state.expire_offers(&[1], 99).unwrap(), (vec![], vec![1]));
    assert_eq!(state.market_revision, 1);
    assert_eq!(
        state.expire_offers(&[3, 99, 2, 1], 100).unwrap(),
        (vec![3, 1], vec![99, 2])
    );
    assert_eq!(state.market_revision, 2);
    assert_eq!(state.terminal_offer_ids.slots[..2], [Some(3), Some(1)]);
    assert_eq!(state.offers.get(&3).unwrap().closed_at_ns, Some(99));
    assert_eq!(state.offers.get(&1).unwrap().closed_at_ns, Some(100));
    assert_eq!(
        state.expire_offers(&[3, 1], 101).unwrap(),
        (vec![], vec![3, 1])
    );
    assert_eq!(state.market_revision, 2);
    assert_eq!(state.expire_offers(&[2], 102).unwrap(), (vec![2], vec![]));
    assert_eq!(state.market_revision, 3);
    assert!(
        state
            .merchants
            .iter()
            .all(|merchant| merchant.pending_offer_count == 0)
    );
    assert!(
        state
            .merchants
            .iter()
            .all(|merchant| merchant.actions.last_action_id() == 0)
    );
}

#[test]
fn terminal_transitions_release_slots_once_and_never_reopen_records() {
    let mut state = state();
    for id in 1..=3 {
        state
            .insert_pending_offer(offer(id, MerchantId::Rex, MerchantId::Luna, 100))
            .unwrap();
    }
    assert_eq!(
        state.close_offer(1, OfferStatus::Accepted, 99, None),
        Err(StateError::InvalidTransition)
    );
    assert_eq!(
        state.close_offer(1, OfferStatus::Expired, 99, None),
        Err(StateError::InvalidTransition)
    );
    state
        .close_offer(2, OfferStatus::Cancelled, 99, None)
        .unwrap();
    state
        .close_offer(1, OfferStatus::Accepted, 99, Some(1))
        .unwrap();
    assert_eq!(state.terminal_offer_ids.slots[..2], [Some(2), Some(1)]);
    let before = borsh::to_vec(&state).unwrap();
    assert_eq!(
        state.close_offer(2, OfferStatus::Cancelled, 99, None),
        Err(StateError::InvalidTransition)
    );
    assert_eq!(
        state.close_offer(3, OfferStatus::Accepted, 100, Some(2)),
        Err(StateError::InvalidTransition)
    );
    assert_eq!(borsh::to_vec(&state).unwrap(), before);
    assert_eq!(state.merchants[0].pending_offer_count, 1);
    assert_eq!(state.offers.get(&1).unwrap().settled_trade_id, Some(1));
}

#[test]
fn histories_roll_over_without_tombstones_id_reuse_or_pruning_live_offers() {
    let mut state = state();
    let player: AccountId = "player.testnet".parse().unwrap();
    state.add_player(player.clone()).unwrap();
    state
        .insert_pending_offer(offer(1, MerchantId::Rex, MerchantId::Luna, u64::MAX))
        .unwrap();
    let mut sizes = Vec::new();
    for id in 2..=401 {
        state
            .insert_pending_offer(offer(id, MerchantId::Luna, MerchantId::Bolt, 10))
            .unwrap();
        state
            .close_offer(id, OfferStatus::Cancelled, 1, None)
            .unwrap();
        state.append_trade(trade(id - 1)).unwrap();
        if id == 101 || id == 201 || id == 401 {
            state.players.flush();
            state.offers.flush();
            state.trades.flush();
            env::state_write(&state);
            sizes.push(env::storage_usage());
        }
    }
    assert_eq!(sizes[0], sizes[1]);
    assert_eq!(sizes[1], sizes[2]);
    assert_eq!(state.terminal_offer_ids.count, 100);
    assert_eq!(state.trade_history_ids.count, 100);
    assert_eq!(state.offers_pruned_through, 301);
    assert_eq!(state.trades_pruned_through, 300);
    assert_eq!(state.offers.get(&1).unwrap().status, OfferStatus::Pending);
    assert!(state.offers.get(&301).is_none());
    assert!(state.offers.get(&302).is_some());
    assert!(state.trades.get(&300).is_none());
    assert!(state.trades.get(&301).is_some());
    assert_eq!(
        state.insert_pending_offer(offer(2, MerchantId::Luna, MerchantId::Bolt, 10)),
        Err(StateError::InvalidRecord)
    );
    assert_eq!(state.append_trade(trade(1)), Err(StateError::InvalidRecord));
    assert_eq!(state.offer_ids.next_id(), 402);
    assert_eq!(state.trade_ids.next_id(), 401);
    assert_eq!(state.add_player(player), Err(StateError::AlreadyRegistered));
}

#[test]
fn funding_budget_includes_rounded_up_headroom_and_rejects_overflow() {
    assert_eq!(
        storage_funding_required(1, NearToken::from_yoctonear(1))
            .unwrap()
            .as_yoctonear(),
        2
    );
    assert_eq!(
        storage_funding_required(100, NearToken::from_yoctonear(4))
            .unwrap()
            .as_yoctonear(),
        500
    );
    assert_eq!(
        storage_funding_required(u64::MAX, NearToken::from_yoctonear(u128::MAX)),
        Err(StateError::Overflow)
    );
    assert_eq!(
        storage_funding_required(1, NearToken::from_yoctonear(u128::MAX)),
        Err(StateError::Overflow)
    );
}
