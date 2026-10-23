use super::*;
use near_sdk::{borsh, serde_json, test_utils::VMContextBuilder, testing_env};

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn action(action_id: u64) -> LastAction {
    LastAction {
        action_id,
        method: MerchantMethod::ProposeTrade,
        args_sha256: [7; 32],
        market_revision: 2,
        offer_id: Some(1),
        trade_id: None,
        listing_version: None,
    }
}

#[test]
fn actors_and_resources_have_exact_public_identities() {
    for (index, id) in MerchantId::ALL.into_iter().enumerate() {
        assert_eq!(id.index(), index);
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, ["\"rex\"", "\"luna\"", "\"bolt\""][index]);
    }
    for (index, resource) in Resource::ALL.into_iter().enumerate() {
        assert_eq!(resource.index(), index);
        assert_eq!(
            serde_json::to_string(&resource).unwrap(),
            ["\"crystal\"", "\"wood\"", "\"herb\"", "\"iron\""][index]
        );
    }
    let player = Actor::Player {
        account_id: account("rex.testnet"),
    };
    let merchant = Actor::Merchant {
        merchant_id: MerchantId::Rex,
    };
    assert_ne!(player, merchant);
    assert_eq!(
        serde_json::to_value(&player).unwrap(),
        serde_json::json!({ "kind": "player", "account_id": "rex.testnet" })
    );
    assert_eq!(
        serde_json::to_value(&merchant).unwrap(),
        serde_json::json!({ "kind": "merchant", "merchant_id": "rex" })
    );
    assert!(serde_json::from_str::<MerchantId>("\"Rex\"").is_err());
    assert!(serde_json::from_str::<Resource>("\"gold\"").is_err());
    assert!(serde_json::from_value::<Actor>(serde_json::json!({ "kind": "player", "account_id": "player.testnet", "merchant_id": "rex" })).is_err());
    for actor in [player, merchant] {
        assert_eq!(
            borsh::from_slice::<Actor>(&borsh::to_vec(&actor).unwrap()).unwrap(),
            actor
        );
    }
}

#[test]
fn gold_checks_caps_and_preserves_balance_on_rejection() {
    let mut balances = Balances::new(MAX_ACTOR_GOLD, Inventory::default()).unwrap();
    let before = balances;
    assert_eq!(balances.credit_gold(1), Err(StateError::LimitExceeded));
    assert_eq!(balances, before);
    assert_eq!(
        balances.debit_gold(MAX_ACTOR_GOLD + 1),
        Err(StateError::InsufficientBalance)
    );
    assert_eq!(balances, before);
    balances.debit_gold(MAX_ACTOR_GOLD).unwrap();
    assert_eq!(balances.gold(), 0);
    balances.credit_gold(STARTER_GOLD).unwrap();
    assert_eq!(balances.gold(), STARTER_GOLD);
    assert_eq!(
        Balances::new(MAX_ACTOR_GOLD + 1, Inventory::default()),
        Err(StateError::LimitExceeded)
    );
}

#[test]
fn inventories_are_bounded_and_resources_do_not_alias() {
    let mut inventory = Inventory::new([1, 2, 3, 4]).unwrap();
    for resource in Resource::ALL {
        let before = inventory;
        assert_eq!(
            inventory.credit(resource, MAX_ACTOR_RESOURCE),
            Err(StateError::LimitExceeded)
        );
        assert_eq!(inventory, before);
        assert_eq!(
            inventory.debit(resource, MAX_ACTOR_RESOURCE),
            Err(StateError::InsufficientBalance)
        );
        assert_eq!(inventory, before);
        let amount = inventory.amount(resource);
        inventory.debit(resource, amount).unwrap();
        assert_eq!(inventory.amount(resource), 0);
        inventory.credit(resource, amount).unwrap();
        assert_eq!(inventory, before);
    }
    assert!(Inventory::new([MAX_ACTOR_RESOURCE + 1, 0, 0, 0]).is_err());
    assert!(Inventory::new([MAX_ACTOR_RESOURCE; 4]).is_ok());
}

#[test]
fn integer_overflow_and_invalid_trade_terms_never_wrap() {
    assert_eq!(
        checked_credit(u64::MAX, 1, u64::MAX),
        Err(StateError::Overflow)
    );
    assert_eq!(checked_debit(0, 1), Err(StateError::InsufficientBalance));
    assert_eq!(checked_increment(u64::MAX), Err(StateError::Overflow));
    assert_eq!(checked_trade_total(100, 100), Ok(10_000));
    for (quantity, price) in [(0, 1), (1, 0), (101, 1), (1, 101), (u64::MAX, u64::MAX)] {
        assert_eq!(
            checked_trade_total(quantity, price),
            Err(StateError::InvalidTrade)
        );
    }
}

#[test]
fn ids_start_at_one_never_reuse_and_stop_before_overflow() {
    let mut ids = IdSequence::default();
    assert_eq!(ids.allocate(), Ok(1));
    assert_eq!(ids.allocate(), Ok(2));
    let mut restored = borsh::from_slice::<IdSequence>(&borsh::to_vec(&ids).unwrap()).unwrap();
    assert_eq!(restored.allocate(), Ok(3));
    let mut exhausted = IdSequence { next_id: u64::MAX };
    assert_eq!(exhausted.allocate(), Err(StateError::Overflow));
    assert_eq!(exhausted.next_id(), u64::MAX);
}

#[test]
fn merchant_actions_advance_exactly_once_and_keep_the_last_receipt() {
    let mut sequence = ActionSequence::default();
    assert_eq!(sequence.last_action_id(), 0);
    assert_eq!(sequence.last_action(), None);
    sequence.record(action(1)).unwrap();
    for (rejected, error) in [
        (0, StateError::ActionUsed),
        (1, StateError::ActionUsed),
        (3, StateError::ActionGap),
    ] {
        let before = borsh::to_vec(&sequence).unwrap();
        assert_eq!(sequence.record(action(rejected)), Err(error));
        assert_eq!(borsh::to_vec(&sequence).unwrap(), before);
    }
    sequence.record(action(2)).unwrap();
    assert_eq!(sequence.last_action_id(), 2);
    assert_eq!(sequence.last_action(), Some(&action(2)));
    let mut bytes = u64::MAX.to_le_bytes().to_vec();
    bytes.push(0);
    let mut exhausted = borsh::from_slice::<ActionSequence>(&bytes).unwrap();
    assert_eq!(exhausted.next_action_id(), Err(StateError::Overflow));
    assert_eq!(exhausted.record(action(1)), Err(StateError::ActionUsed));
    assert_eq!(borsh::to_vec(&exhausted).unwrap(), bytes);
}

#[test]
fn inactive_listings_retain_prices_and_versions() {
    let inactive = Listing::new(6, 0, false).unwrap();
    assert_eq!(inactive.version, 1);
    assert_eq!(inactive.unit_price, 6);
    assert_eq!(
        borsh::from_slice::<Listing>(&borsh::to_vec(&inactive).unwrap()).unwrap(),
        inactive
    );
    assert!(Listing::new(100, 100, true).is_ok());
    for (price, quantity, active) in [
        (0, 0, false),
        (101, 1, true),
        (1, 0, true),
        (1, 1, false),
        (1, 101, true),
    ] {
        assert_eq!(
            Listing::new(price, quantity, active),
            Err(StateError::InvalidListing)
        );
    }
}

#[test]
fn lookup_records_persist_with_separate_prefixes_and_independent_counters() {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(account("market.testnet"))
            .build()
    );
    let merchants = MerchantId::ALL.map(|merchant_id| Merchant {
        merchant_id,
        controller_account_id: account(&format!("{:?}.testnet", merchant_id).to_lowercase()),
        balances: Balances::default(),
        listings: [Listing::new(1, 0, false).unwrap(); 4],
        actions: ActionSequence::default(),
        pending_offer_count: 0,
    });
    let mut state = MarketState {
        owner_account_id: account("owner.testnet"),
        paused: true,
        registered_player_count: 0,
        total_issued_gold: 0,
        resource_supply: Inventory::default(),
        merchants,
        players: LookupMap::new(StorageKey::Players),
        offers: LookupMap::new(StorageKey::Offers),
        trades: LookupMap::new(StorageKey::Trades),
        offer_ids: IdSequence::default(),
        trade_ids: IdSequence::default(),
        market_revision: 1,
        offers_pruned_through: 0,
        trades_pruned_through: 0,
        pending_offer_ids: [None; MAX_PENDING_OFFERS],
        terminal_offer_ids: RetainedIds::default(),
        trade_history_ids: RetainedIds::default(),
    };
    let player = account("player.testnet");
    state.players.insert(
        player.clone(),
        Player {
            account_id: player.clone(),
            balances: Balances::new(100, Inventory::default()).unwrap(),
        },
    );
    let offer_id = state.offer_ids.allocate().unwrap();
    state.offers.insert(
        offer_id,
        Offer {
            offer_id,
            proposer: MerchantId::Rex,
            buyer: MerchantId::Rex,
            seller: MerchantId::Luna,
            counterparty: MerchantId::Luna,
            resource: Resource::Crystal,
            quantity: 4,
            unit_price: 6,
            total_price: 24,
            created_at_ns: 1,
            expires_at_ns: 100,
            status: OfferStatus::Pending,
            closed_at_ns: None,
            settled_trade_id: None,
            proposal_action: ActionRef {
                merchant_id: MerchantId::Rex,
                action_id: 1,
            },
        },
    );
    let trade_id = state.trade_ids.allocate().unwrap();
    state.trades.insert(
        trade_id,
        Trade {
            trade_id,
            kind: TradeKind::PlayerPurchase,
            buyer: Actor::Player {
                account_id: player.clone(),
            },
            seller: Actor::Merchant {
                merchant_id: MerchantId::Rex,
            },
            resource: Resource::Crystal,
            quantity: 12,
            unit_price: 4,
            total_price: 48,
            offer_id: None,
            buyer_gold_after: 52,
            seller_gold_after: 228,
            buyer_resource_after: 12,
            seller_resource_after: 3,
            settled_at_ns: 1,
            market_revision: 2,
        },
    );
    state.players.flush();
    state.offers.flush();
    state.trades.flush();
    let encoded = borsh::to_vec(&state).unwrap();
    drop(state);
    let mut restored = borsh::from_slice::<MarketState>(&encoded).unwrap();
    assert_eq!(restored.players.get(&player).unwrap().balances.gold(), 100);
    assert_eq!(restored.offers.get(&offer_id).unwrap().total_price, 24);
    assert_eq!(restored.trades.get(&trade_id).unwrap().buyer_gold_after, 52);
    assert_eq!(restored.pending_offer_ids.len(), 12);
    assert_eq!(restored.terminal_offer_ids.slots.len(), 100);
    assert_eq!(restored.trade_history_ids.slots.len(), 100);
    assert!(restored.offers.remove(&offer_id).is_some());
    assert!(restored.trades.remove(&trade_id).is_some());
    assert_eq!(restored.offer_ids.allocate(), Ok(2));
    assert_eq!(restored.trade_ids.allocate(), Ok(2));
    assert!(restored.players.contains_key(&player));
}
