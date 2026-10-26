use crate::{Decimal, Market, MerchantControllers, initialization::initialized_state, state::*};
use near_sdk::{
    borsh,
    serde_json::{Value, json},
    test_utils::VMContextBuilder,
    testing_env,
};

const NOW: u64 = 10_000_000_000;
const SUPPLY: [u128; 4] = [29, 25, 26, 24];

fn context(caller: &str, args: Value, now: u64) {
    let mut ctx = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .block_timestamp(now)
        .build();
    ctx.input = near_sdk::serde_json::to_vec(&args).unwrap().into();
    testing_env!(ctx);
}

fn market() -> Market {
    context("market.testnet", json!({}), NOW);
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

fn ledger(market: &Market, players: &[&str]) -> Vec<Balances> {
    let mut balances: Vec<_> = market.market.merchants.iter().map(|m| m.balances).collect();
    for player in players {
        balances.push(
            market
                .market
                .players
                .get(&player.parse::<near_sdk::AccountId>().unwrap())
                .unwrap()
                .balances,
        );
    }
    balances
}

fn assert_economy(market: &Market, players: &[&str]) {
    let actors = ledger(market, players);
    assert_eq!(market.market.registered_player_count, players.len() as u64);
    let expected_gold = 550 + 100 * players.len() as u128;
    assert_eq!(
        actors.iter().map(|b| u128::from(b.gold())).sum::<u128>(),
        expected_gold
    );
    assert_eq!(u128::from(market.market.total_issued_gold), expected_gold);
    for (resource, expected) in Resource::ALL.into_iter().zip(SUPPLY) {
        assert_eq!(
            actors
                .iter()
                .map(|b| u128::from(b.inventory.amount(resource)))
                .sum::<u128>(),
            expected
        );
        assert_eq!(
            u128::from(market.market.resource_supply.amount(resource)),
            expected
        );
    }
}

fn assert_transfer(
    before: &[Balances],
    after: &[Balances],
    buyer: usize,
    seller: usize,
    resource: Resource,
    quantity: u64,
    total: u64,
) {
    assert_eq!(before.len(), after.len());
    for (index, (old, new)) in before.iter().zip(after).enumerate() {
        let gold = if index == buyer {
            old.gold() - total
        } else if index == seller {
            old.gold() + total
        } else {
            old.gold()
        };
        assert_eq!(new.gold(), gold);
        for item in Resource::ALL {
            let amount = old.inventory.amount(item);
            let expected = if item == resource && index == buyer {
                amount + quantity
            } else if item == resource && index == seller {
                amount - quantity
            } else {
                amount
            };
            assert_eq!(new.inventory.amount(item), expected);
        }
    }
}

fn register(market: &mut Market, existing: &[&str], player: &str) {
    let before = ledger(market, existing);
    context(player, json!({}), NOW);
    market.register_player();
    let mut players = existing.to_vec();
    players.push(player);
    let after = ledger(market, &players);
    assert_eq!(&after[..before.len()], before.as_slice());
    assert_eq!(after.last().unwrap().gold(), 100);
    assert_eq!(after.last().unwrap().inventory, Inventory::default());
    assert_economy(market, &players);
}

#[test]
fn seed_and_registration_are_the_only_issuance_and_duplicate_grants_add_nothing() {
    let mut market = market();
    assert_economy(&market, &[]);
    register(&mut market, &[], "first.testnet");
    register(&mut market, &["first.testnet"], "second.testnet");
    context("first.testnet", json!({}), NOW);
    let before = borsh::to_vec(&market.market).unwrap();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| market.register_player()))
            .is_err()
    );
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
    assert_economy(&market, &["first.testnet", "second.testnet"]);
    assert_eq!(market.market.trade_ids.next_id(), 1);
}

#[test]
fn purchases_and_all_directed_merchant_pairs_conserve_every_resource_and_exact_transfers() {
    let mut market = market();
    register(&mut market, &[], "first.testnet");
    register(&mut market, &["first.testnet"], "second.testnet");
    let players = ["first.testnet", "second.testnet"];
    for (player, merchant, resource, quantity) in [
        (0, MerchantId::Rex, Resource::Crystal, 12),
        (1, MerchantId::Bolt, Resource::Wood, 2),
        (0, MerchantId::Luna, Resource::Herb, 3),
        (1, MerchantId::Bolt, Resource::Iron, 1),
    ] {
        let before = ledger(&market, &players);
        let listing = market.market.merchants[merchant.index()].listings[resource.index()];
        let total = quantity * listing.unit_price;
        context(
            players[player],
            json!({"merchant_id":merchant,"resource":resource,"quantity":quantity.to_string(),"max_total_price":total.to_string(),"listing_version":listing.version.to_string()}),
            NOW,
        );
        market.buy_from_merchant(
            merchant,
            resource,
            Decimal(quantity),
            Decimal(total),
            Decimal(listing.version),
        );
        assert_transfer(
            &before,
            &ledger(&market, &players),
            3 + player,
            merchant.index(),
            resource,
            quantity,
            total,
        );
        assert_economy(&market, &players);
    }
    let mut count = 0;
    for resource in Resource::ALL {
        for buyer in MerchantId::ALL {
            for seller in MerchantId::ALL {
                if buyer == seller {
                    continue;
                }
                let proposer = if count % 2 == 0 { buyer } else { seller };
                let counterparty = if proposer == buyer { seller } else { buyer };
                let action = market.market.merchants[proposer.index()]
                    .actions
                    .last_action_id()
                    + 1;
                let before = ledger(&market, &players);
                let caller = market.market.merchants[proposer.index()]
                    .controller_account_id
                    .to_string();
                context(
                    &caller,
                    json!({"proposer":proposer,"buyer":buyer,"seller":seller,"resource":resource,"quantity":"1","total_price":"2","expires_at_ns":"121000000000","action_id":action.to_string()}),
                    NOW,
                );
                let offer = market.propose_trade(
                    proposer,
                    buyer,
                    seller,
                    resource,
                    Decimal(1),
                    Decimal(2),
                    Decimal(121_000_000_000),
                    Decimal(action),
                );
                assert_eq!(ledger(&market, &players), before);
                assert_economy(&market, &players);
                let id = offer.data.offer.offer_id.0;
                let action = market.market.merchants[counterparty.index()]
                    .actions
                    .last_action_id()
                    + 1;
                let caller = market.market.merchants[counterparty.index()]
                    .controller_account_id
                    .to_string();
                context(
                    &caller,
                    json!({"offer_id":id.to_string(),"action_id":action.to_string()}),
                    NOW,
                );
                market.accept_trade(Decimal(id), Decimal(action));
                assert_transfer(
                    &before,
                    &ledger(&market, &players),
                    buyer.index(),
                    seller.index(),
                    resource,
                    1,
                    2,
                );
                assert_economy(&market, &players);
                count += 1;
            }
        }
    }
    assert_eq!(count, 24);
    assert_eq!(market.market.trade_ids.next_id(), 29);
    register(&mut market, &players, "third.testnet");
    assert_eq!(market.market.total_issued_gold, 850);
    assert_eq!(market.market.trade_ids.next_id(), 29);
}

#[test]
fn listing_proposal_cancellation_expiry_and_pause_do_not_move_or_issue_assets() {
    let mut market = market();
    register(&mut market, &[], "first.testnet");
    let players = ["first.testnet"];
    let before = ledger(&market, &players);
    context(
        "rex.testnet",
        json!({"merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"2","active":true,"expected_version":"1","action_id":"1"}),
        NOW,
    );
    market.set_listing(
        MerchantId::Rex,
        Resource::Crystal,
        Decimal(5),
        Decimal(2),
        true,
        Decimal(1),
        Decimal(1),
    );
    assert_eq!(ledger(&market, &players), before);
    assert_economy(&market, &players);
    for (action, id, expiry) in [(2, 1, NOW + 1), (4, 2, NOW + 1)] {
        context(
            "rex.testnet",
            json!({"proposer":"rex","buyer":"rex","seller":"luna","resource":"crystal","quantity":"1","total_price":"2","expires_at_ns":expiry.to_string(),"action_id":action.to_string()}),
            NOW,
        );
        market.propose_trade(
            MerchantId::Rex,
            MerchantId::Rex,
            MerchantId::Luna,
            Resource::Crystal,
            Decimal(1),
            Decimal(2),
            Decimal(expiry),
            Decimal(action),
        );
        assert_eq!(ledger(&market, &players), before);
        assert_economy(&market, &players);
        if id == 1 {
            context("rex.testnet", json!({"offer_id":"1","action_id":"3"}), NOW);
            market.cancel_trade(Decimal(1), Decimal(3));
        } else {
            context("cleaner.testnet", json!({"offer_ids":["2"]}), NOW + 1);
            market.expire_offers(vec![Decimal(2)]);
        }
        assert_eq!(ledger(&market, &players), before);
        assert_economy(&market, &players);
    }
    context("owner.testnet", json!({}), NOW + 1);
    market.pause_market();
    assert_eq!(ledger(&market, &players), before);
    assert_economy(&market, &players);
    context("owner.testnet", json!({}), NOW + 1);
    market.resume_market();
    assert_eq!(ledger(&market, &players), before);
    assert_economy(&market, &players);
    assert_eq!(market.market.trade_ids.next_id(), 1);
}
