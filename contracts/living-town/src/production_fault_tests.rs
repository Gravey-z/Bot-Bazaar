use super::tests::{context, start, town};
use super::*;

// Root serialization alone omits LookupMap entries: include every affected
// ledger/shop/job/command lane as well as NPC balances and reservations.
fn fingerprint(t: &LivingTown) -> Value {
    let account: AccountId = "player.testnet".parse().unwrap();
    let jobs = [1, 2].map(|id| t.jobs.get(&id).map(|j| near_sdk::borsh::to_vec(j).unwrap()));
    json!({
        "root":near_sdk::borsh::to_vec(t).unwrap(),
        "player":t.players.get(&account).map(|p|near_sdk::borsh::to_vec(p).unwrap()),
        "npcs":near_sdk::borsh::to_vec(&t.npcs).unwrap(),
        "shop":t.shops.get(&4).map(|s|near_sdk::borsh::to_vec(s).unwrap()),
        "jobs":jobs,
        "slot":t.active_jobs.get(&4),
        "command":t.commands.get(&"account:player.testnet".to_owned()).map(|c|near_sdk::borsh::to_vec(c).unwrap())
    })
}

#[test]
fn rejected_start_matrix_preserves_all_balances_reservations_jobs_and_commands() {
    let mut t = town();
    let account: AccountId = "player.testnet".parse().unwrap();
    let original = t.players.get(&account).unwrap().clone();
    for case in 0..7 {
        t.players.insert(account.clone(), original.clone());
        let p = t.players.get_mut(&account).unwrap();
        match case {
            0 => p.inventory.quantities[0] = 0,
            1 => p.reservations.listing.quantities[2] = 20,
            2 => p.reservations.trade.quantities[0] = 10,
            3 => p.reservations.output.quantities[4] = 1000,
            4 => {
                p.inventory.quantities[4] = 999;
                p.reservations.inbound.quantities[4] = 1;
            }
            _ => {}
        }
        let before = fingerprint(&t);
        let q = if case == 5 {
            0
        } else if case == 6 {
            11
        } else {
            1
        };
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut t, 3, q))).is_err()
        );
        assert_eq!(fingerprint(&t), before, "fault case {case}");
    }
    t.players.insert(account, original);
    start(&mut t, 3, 1);
    let before = fingerprint(&t);
    // Matching retry is a pure acknowledgement; conflicting payload and a new
    // sequence against an occupied slot must preserve every affected record.
    assert_eq!(start(&mut t, 3, 1)["data"]["replayed"], true);
    assert_eq!(fingerprint(&t), before);
    for (seq, q) in [(3, 2), (4, 1)] {
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut t, seq, q)))
                .is_err()
        );
        assert_eq!(fingerprint(&t), before);
    }
}

#[test]
fn unsupported_config_during_running_job_fails_closed_then_original_terms_settle() {
    let mut t = town();
    start(&mut t, 3, 3);
    let terms = t.jobs.get(&1).unwrap().terms.view();
    let ready = t.jobs.get(&1).unwrap().terms.ready_at_ns;
    // Controlled incompatible-root injection, not an implemented upgrade or
    // recipe-tuning method. Production currently supports only config 1.
    t.config_version = 2;
    context("keeper.testnet", json!({"job_id":"1"}), ready);
    let before = fingerprint(&t);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || t.complete_production(Decimal(1))
        ))
        .is_err()
    );
    assert_eq!(fingerprint(&t), before);
    assert_eq!(t.jobs.get(&1).unwrap().terms.view(), terms);
    t.config_version = 1;
    context("keeper.testnet", json!({"job_id":"1"}), ready - 1);
    let before = fingerprint(&t);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || t.complete_production(Decimal(1))
        ))
        .is_err()
    );
    assert_eq!(fingerprint(&t), before);
    context("keeper.testnet", json!({"job_id":"1"}), ready);
    let result = t.complete_production(Decimal(1));
    assert_eq!(result["data"]["outcome"]["job"]["recipe_version"], "1");
    assert_eq!(
        result["data"]["outcome"]["ledger"]["inventory"]["held"]["health_potion"],
        "3"
    );
    assert_eq!(t.jobs.get(&1).unwrap().terms.view(), terms);
    let before = fingerprint(&t);
    assert_eq!(t.complete_production(Decimal(1))["data"]["replayed"], true);
    assert_eq!(fingerprint(&t), before);
}
