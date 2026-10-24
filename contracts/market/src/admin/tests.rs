use super::*;
use crate::{MerchantControllers, initialization::initialized_state};
use near_sdk::{borsh, test_utils::VMContextBuilder, testing_env};

fn context(predecessor: &str) {
    let mut context = VMContextBuilder::new()
        .current_account_id("market.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_id("owner.testnet".parse().unwrap())
        .block_height(42)
        .block_timestamp(100)
        .build();
    context.input = b"{}".to_vec().into();
    testing_env!(context);
}

fn market() -> Market {
    context("owner.testnet");
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

#[test]
fn owner_toggles_return_snapshots_and_retries_preserve_state() {
    let mut market = market();
    for (paused, expected_revision, changed) in [
        (false, 1, false),
        (true, 2, true),
        (true, 2, false),
        (false, 3, true),
        (false, 3, false),
    ] {
        let before = borsh::to_vec(&market.market).unwrap();
        let result = if paused {
            market.pause_market()
        } else {
            market.resume_market()
        };
        assert_eq!(result.market_revision.0, expected_revision);
        assert_eq!(result.block_height.0, 42);
        assert_eq!(result.block_timestamp_ns.0, 100);
        assert_eq!(result.data.paused, paused);
        assert_eq!(result.data.changed, changed);
        if !changed {
            assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
        }
    }
}

#[test]
fn owner_signer_does_not_authorize_an_intermediary_predecessor() {
    let mut market = market();
    for predecessor in [
        "attacker.testnet",
        "market.testnet",
        "rex.testnet",
        "proxy.testnet",
    ] {
        context(predecessor);
        let before = borsh::to_vec(&market.market).unwrap();
        for paused in [false, true] {
            let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                market.set_paused(paused)
            }));
            assert!(failure.is_err());
            assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
        }
    }
}

#[test]
fn overflow_rejects_a_toggle_but_allows_a_no_change_retry() {
    let mut market = market();
    market.market.market_revision = u64::MAX;
    let before = borsh::to_vec(&market.market).unwrap();
    assert!(!market.resume_market().data.changed);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| market.pause_market()));
    assert!(result.is_err());
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
    market.market.paused = true;
    assert!(!market.pause_market().data.changed);
    let before = borsh::to_vec(&market.market).unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| market.resume_market()));
    assert!(result.is_err());
    assert_eq!(borsh::to_vec(&market.market).unwrap(), before);
}
