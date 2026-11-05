use super::tests::{context, start, town};
use super::*;

#[test]
fn pause_rejects_new_starts_but_retains_replay_and_earned_completion() {
    let mut t = town();
    t.paused = true;
    let before = t
        .players
        .get(&"player.testnet".parse::<AccountId>().unwrap())
        .unwrap()
        .ledger();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut t, 3, 1))).is_err()
    );
    assert_eq!(t.next_job_id, 1);
    assert_eq!(
        t.players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap()
            .ledger(),
        before
    );
    t.paused = false;
    let original = start(&mut t, 3, 1);
    t.paused = true;
    let replay = start(&mut t, 3, 1);
    assert_eq!(replay["data"]["outcome"], original["data"]["outcome"]);
    assert_eq!(replay["data"]["replayed"], true);
    let ready = t.jobs.get(&1).unwrap().terms.ready_at_ns;
    context("keeper.testnet", json!({"job_id":"1"}), ready);
    t.complete_production(Decimal(1));
    let ledger = t
        .players
        .get(&"player.testnet".parse::<AccountId>().unwrap())
        .unwrap()
        .ledger();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut t, 4, 1))).is_err()
    );
    assert_eq!(
        t.players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap()
            .ledger(),
        ledger
    );
    assert_eq!(t.next_job_id, 2);
}

#[test]
fn archived_job_never_reopens_a_start_or_completion_claim() {
    let mut t = town();
    let original = start(&mut t, 3, 1);
    let template = t.jobs.get(&1).unwrap().clone();
    let ready = template.terms.ready_at_ns;
    context("keeper.testnet", json!({"job_id":"1"}), ready);
    t.complete_production(Decimal(1));
    // Synthetic NPC admissions isolate archival and replay barriers. They do
    // not claim funded material supply or a completed long-run economy.
    for id in 2..=258 {
        let mut j = template.clone();
        j.id = id;
        j.shop_id = 1;
        j.owner = Owner::Merchant(0);
        t.jobs.insert(id, j);
        t.active_jobs.insert(1, id);
        t.next_job_id = id + 1;
        t.npcs[0].reservations.output.quantities[4] = 1;
        context("keeper.testnet", json!({"job_id":id.to_string()}), ready);
        t.complete_production(Decimal(id));
    }
    assert!(t.jobs.get(&1).is_none());
    assert_eq!(t.completed_jobs.len(), 256);
    let before = t
        .players
        .get(&"player.testnet".parse::<AccountId>().unwrap())
        .unwrap()
        .ledger();
    let next = t.next_job_id;
    let replay = start(&mut t, 3, 1);
    assert_eq!(replay["data"]["replayed"], true);
    assert_eq!(replay["data"]["outcome"], original["data"]["outcome"]);
    assert_eq!(t.next_job_id, next);
    assert!(t.active_jobs.get(&4).is_none());
    assert_eq!(
        t.players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap()
            .ledger(),
        before
    );
    context("keeper.testnet", json!({"job_id":"1"}), ready);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || t.complete_production(Decimal(1))
        ))
        .is_err()
    );
    // The next real command may allocate a different job. The old sequence is
    // permanently rejected after the command lane advances beyond it.
    let command = Command {
        sequence: Decimal(4),
        config_version: Decimal(1),
        valid_until_ns: Decimal(ready + 500_000_000_000),
    };
    context(
        "player.testnet",
        json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"1","expected_shop_revision":"3","command":command}),
        ready,
    );
    t.start_production(
        Decimal(4),
        RecipeId::HealthPotion,
        Decimal(1),
        Decimal(1),
        Decimal(3),
        command,
    );
    let current = t.next_job_id;
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut t, 3, 1))).is_err()
    );
    assert_eq!(t.next_job_id, current);
}
