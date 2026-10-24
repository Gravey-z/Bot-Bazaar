use std::path::Path;

use anyhow::{Context, Result};
use bot_bazaar_market::state::{MarketState, MerchantId, Resource};
use near_sdk::borsh;
use near_workspaces::operations::Function;
use near_workspaces::types::NearToken;
use serde_json::json;

fn assert_seed(bytes: &[u8], owner: &str, controllers: [&str; 3]) -> Result<()> {
    let state = borsh::from_slice::<MarketState>(bytes)?;
    assert_eq!(state.owner_account_id.as_str(), owner);
    assert!(!state.paused);
    assert_eq!(state.market_revision, 1);
    assert_eq!(state.registered_player_count, 0);
    assert_eq!(state.total_issued_gold, 550);
    assert_eq!(state.offer_ids.next_id(), 1);
    assert_eq!(state.trade_ids.next_id(), 1);
    assert_eq!(state.offers_pruned_through, 0);
    assert_eq!(state.trades_pruned_through, 0);
    assert!(state.pending_offer_ids.iter().all(Option::is_none));
    assert_eq!(state.terminal_offer_ids.count, 0);
    assert_eq!(state.trade_history_ids.count, 0);
    let inventory = [[15, 4, 2, 10], [12, 3, 20, 2], [2, 18, 4, 12]];
    let prices = [[4, 3, 4, 5], [6, 3, 3, 6], [7, 2, 4, 5]];
    let quantities = [[15, 2, 0, 6], [8, 1, 12, 0], [0, 10, 2, 6]];
    for id in MerchantId::ALL {
        let index = id.index();
        let merchant = &state.merchants[index];
        assert_eq!(merchant.merchant_id, id);
        assert_eq!(merchant.controller_account_id.as_str(), controllers[index]);
        assert_eq!(merchant.balances.gold(), [180, 220, 150][index]);
        assert_eq!(merchant.actions.last_action_id(), 0);
        assert_eq!(merchant.actions.last_action(), None);
        assert_eq!(merchant.pending_offer_count, 0);
        for resource in Resource::ALL {
            let slot = resource.index();
            assert_eq!(
                merchant.balances.inventory.amount(resource),
                inventory[index][slot]
            );
            let listing = merchant.listings[slot];
            assert_eq!(listing.unit_price, prices[index][slot]);
            assert_eq!(listing.quantity, quantities[index][slot]);
            assert_eq!(listing.active, quantities[index][slot] > 0);
            assert_eq!(listing.version, 1);
            assert_eq!(
                state.resource_supply.amount(resource),
                [29, 25, 26, 24][slot]
            );
        }
    }
    Ok(())
}

fn wasm() -> Result<Vec<u8>> {
    let wasm_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/near/bot_bazaar_market.wasm");
    std::fs::read(wasm_path)
        .context("Build the contract with cargo near before running the sandbox test")
}

#[tokio::test]
async fn market_initialization() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let args = json!({ "owner_account_id": owner.id(), "merchant_controllers": { "rex": rex.id(), "luna": luna.id(), "bolt": bolt.id() } });
    let empty = contract.view_state().await?;
    assert!(empty.is_empty());
    for caller in [&attacker, &owner, &rex] {
        let mut takeover = args.clone();
        takeover["owner_account_id"] = json!(caller.id());
        let result = caller
            .call(contract.id(), "initialize_market")
            .args_json(takeover)
            .transact()
            .await?;
        assert!(
            result
                .into_result()
                .unwrap_err()
                .to_string()
                .contains("BB:E_UNAUTHORIZED")
        );
        assert_eq!(contract.view_state().await?, empty);
    }
    let legacy = contract.call("new").args_json(json!({})).transact().await?;
    assert!(legacy.into_result().is_err());
    assert_eq!(contract.view_state().await?, empty);
    for role in ["rex", "luna", "bolt"] {
        for reserved in [owner.id(), contract.id()] {
            let mut invalid = args.clone();
            invalid["merchant_controllers"][role] = json!(reserved);
            let result = contract
                .call("initialize_market")
                .args_json(invalid)
                .transact()
                .await?;
            assert!(
                result
                    .into_result()
                    .unwrap_err()
                    .to_string()
                    .contains("BB:E_INVALID_CONTROLLERS")
            );
            assert_eq!(contract.view_state().await?, empty);
        }
    }
    for (first, second) in [("rex", "luna"), ("rex", "bolt"), ("luna", "bolt")] {
        let mut invalid = args.clone();
        invalid["merchant_controllers"][second] = invalid["merchant_controllers"][first].clone();
        let result = contract
            .call("initialize_market")
            .args_json(invalid)
            .transact()
            .await?;
        assert!(
            result
                .into_result()
                .unwrap_err()
                .to_string()
                .contains("BB:E_INVALID_CONTROLLERS")
        );
        assert_eq!(contract.view_state().await?, empty);
    }
    let mut malformed = Vec::new();
    let mut input = args.clone();
    input["gold"] = json!(999);
    malformed.push(input);
    let mut input = args.clone();
    input["merchant_controllers"]["extra"] = json!(attacker.id());
    malformed.push(input);
    let mut input = args.clone();
    input.as_object_mut().unwrap().remove("owner_account_id");
    malformed.push(input);
    let mut input = args.clone();
    input["merchant_controllers"]
        .as_object_mut()
        .unwrap()
        .remove("bolt");
    malformed.push(input);
    let mut input = args.clone();
    input["owner_account_id"] = json!("INVALID!");
    malformed.push(input);
    let mut input = args.clone();
    input["merchant_controllers"]["rex"] = json!(null);
    malformed.push(input);
    malformed.push(json!([owner.id(), args["merchant_controllers"].clone()]));
    let mut input = args.clone();
    input["merchant_controllers"] = json!([rex.id(), luna.id(), bolt.id()]);
    malformed.push(input);
    for invalid in malformed {
        let result = contract
            .call("initialize_market")
            .args_json(invalid)
            .transact()
            .await?;
        assert!(result.into_result().is_err());
        assert_eq!(contract.view_state().await?, empty);
    }
    let attached = contract
        .call("initialize_market")
        .args_json(args.clone())
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(
        attached
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("deposit")
    );
    assert_eq!(contract.view_state().await?, empty);
    let success = contract
        .call("initialize_market")
        .args_json(args.clone())
        .transact()
        .await?
        .into_result()?;
    assert!(success.raw_bytes()?.is_empty());
    let seeded = contract.view_state().await?;
    assert_eq!(seeded.len(), 1);
    assert_seed(
        seeded
            .get(b"STATE".as_slice())
            .context("Missing initialized state")?,
        owner.id().as_str(),
        [rex.id().as_str(), luna.id().as_str(), bolt.id().as_str()],
    )?;
    let repeated = contract
        .call("initialize_market")
        .args_json(args)
        .transact()
        .await?;
    assert!(
        repeated
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("already been initialized")
    );
    assert_eq!(contract.view_state().await?, seeded);
    Ok(())
}

#[tokio::test]
async fn atomic_deploy_and_initialize() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_create_account().await?;
    let original_contract_state = contract.view_account().await?.contract_state;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let args = json!({ "owner_account_id": contract.id(), "merchant_controllers": { "rex": rex.id(), "luna": luna.id(), "bolt": bolt.id() } });
    let mut invalid = args.clone();
    invalid["merchant_controllers"]["rex"] = json!(contract.id());
    let failed = contract
        .batch(contract.id())
        .deploy(&wasm()?)
        .call(Function::new("initialize_market").args_json(invalid))
        .transact()
        .await?;
    assert!(
        failed
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_INVALID_CONTROLLERS")
    );
    assert!(worker.view_state(contract.id()).await?.is_empty());
    assert_eq!(
        contract.view_account().await?.contract_state,
        original_contract_state
    );
    let result = contract
        .batch(contract.id())
        .deploy(&wasm()?)
        .call(Function::new("initialize_market").args_json(args))
        .transact()
        .await?
        .into_result()?;
    assert!(result.raw_bytes()?.is_empty());
    let storage = worker.view_state(contract.id()).await?;
    assert_seed(
        storage
            .get(b"STATE".as_slice())
            .context("Missing batched state")?,
        contract.id().as_str(),
        [rex.id().as_str(), luna.id().as_str(), bolt.id().as_str()],
    )?;
    Ok(())
}
