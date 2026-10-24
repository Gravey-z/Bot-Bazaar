use super::wasm;
use anyhow::Result;
use bot_bazaar_market::state::{MarketState, storage_funding_required};
use near_sdk::borsh;
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use std::path::Path;

#[tokio::test]
async fn storage_capacity_rollover_and_public_cleanup() -> Result<()> {
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_config(near_sandbox::SandboxConfig {
        additional_config: Some(json!({"trie_viewer_state_size_limit":4 * 1024 * 1024})),
        ..Default::default()
    })
    .await?;
    let worker = near_workspaces::sandbox()
        .rpc_addr(&sandbox.rpc_addr)
        .validator_key(near_workspaces::network::ValidatorKey::HomeDir(
            sandbox.home_dir.path().to_path_buf(),
        ))
        .await?;
    let production = wasm()?;
    let contract = worker.dev_deploy(&production).await?;
    let baseline = contract.view_account().await?.storage_usage;
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":"d".repeat(64),
        "merchant_controllers":{"rex":"a".repeat(64),"luna":"b".repeat(64),"bolt":"c".repeat(64)}
    })).transact().await?.into_result()?;
    let initialized = contract.view_account().await?.storage_usage;
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&fixture)
        .transact()
        .await?
        .into_result()?;
    for _ in 0..10 {
        contract
            .call("fill_players")
            .args_json(json!({"count":100}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    let with_players = contract.view_account().await?.storage_usage;
    let before_capacity = contract.view_state().await?;
    let capacity = contract
        .call("fill_players")
        .args_json(json!({"count":1}))
        .max_gas()
        .transact()
        .await?;
    assert!(capacity.into_result().is_err());
    assert_eq!(contract.view_state().await?, before_capacity);
    let mut rollovers = Vec::new();
    for _ in 0..3 {
        for _ in 0..10 {
            contract
                .call("fill_history")
                .args_json(json!({"count":10}))
                .max_gas()
                .transact()
                .await?
                .into_result()?;
        }
        rollovers.push(contract.view_account().await?.storage_usage);
    }
    assert_eq!(rollovers[0], rollovers[1]);
    assert_eq!(rollovers[1], rollovers[2]);
    contract
        .call("fill_pending")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&production)
        .transact()
        .await?
        .into_result()?;
    let full = contract.view_account().await?;
    let before = contract.view_state().await?;
    assert_eq!(before.len(), 1213);
    let full_state = borsh::from_slice::<MarketState>(before.get(b"STATE".as_slice()).unwrap())?;
    assert_eq!(full_state.registered_player_count, 1000);
    assert!(
        full_state
            .merchants
            .iter()
            .all(|m| m.pending_offer_count == 8)
    );
    assert_eq!(full_state.terminal_offer_ids.count, 100);
    assert_eq!(full_state.trade_history_ids.count, 100);
    assert_eq!(full_state.offers_pruned_through, 201);
    assert_eq!(full_state.trades_pruned_through, 200);
    assert!(full_state.paused);
    let incremental = full.storage_usage - baseline;
    assert!(incremental < 2 * 1024 * 1024);
    let byte_cost = near_sdk::env::storage_byte_cost();
    let funding = storage_funding_required(full.storage_usage, byte_cost)
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    assert!(full.balance >= funding);
    println!(
        "STORAGE baseline={baseline} initialized={initialized} fixture_players={with_players} rollovers={rollovers:?} full={} incremental={incremental} byte_cost={} budget_with_25pct={} balance={}",
        full.storage_usage,
        byte_cost.as_yoctonear(),
        funding.as_yoctonear(),
        full.balance.as_yoctonear()
    );

    let player: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":format!("{:064}",0)}))
        .await?
        .json()?;
    assert_eq!(player["data"]["gold"], "100");
    let live: Value = contract
        .view("get_offer")
        .args_json(json!({"offer_id":"1"}))
        .await?
        .json()?;
    assert_eq!(live["data"]["kind"], "found");
    assert_eq!(live["data"]["offer"]["status"], "pending");
    let page: Value = contract.view("get_offers_for_merchant").args_json(json!({
        "merchant_id":"luna","status":"terminal","after_id":null,"limit":"50","expected_revision":"1"
    })).await?.json()?;
    assert_eq!(page["data"]["items"].as_array().unwrap().len(), 50);
    assert_eq!(page["data"]["history_gap"], true);

    let caller = worker.dev_create_account().await?;
    for args in [
        json!({"offer_ids":[]}),
        json!({"offer_ids":["302","302"]}),
        json!({"offer_ids":["302","0"]}),
        json!({"offer_ids":(1..=25).map(|id|id.to_string()).collect::<Vec<_>>()}),
        json!({"offer_ids":[302]}),
        json!({"offer_ids":["0302"]}),
        json!({"offer_ids":["18446744073709551616"]}),
        json!({"offer_ids":["302"],"extra":"x"}),
        json!({}),
        json!([["302"]]),
    ] {
        let result = caller
            .call(contract.id(), "expire_offers")
            .args_json(args)
            .transact()
            .await?;
        assert!(result.into_result().is_err());
        assert_eq!(contract.view_state().await?, before);
    }
    let duplicate = caller
        .call(contract.id(), "expire_offers")
        .args(br#"{"offer_ids":["302"],"offer_ids":["303"]}"#.to_vec())
        .transact()
        .await?;
    assert!(duplicate.into_result().is_err());
    assert_eq!(contract.view_state().await?, before);
    let deposit = caller
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":["302"]}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(deposit.into_result().is_err());
    assert_eq!(contract.view_state().await?, before);
    let mut ids = vec!["312".to_owned(), "1".to_owned(), "9999".to_owned()];
    ids.extend((302..=311).map(|id| id.to_string()));
    ids.extend((10_000..10_011).map(|id| id.to_string()));
    assert_eq!(ids.len(), 24);
    let cleanup = caller
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":ids.clone()}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let gas = cleanup.total_gas_burnt.as_gas();
    let result: Value = cleanup.json()?;
    assert_eq!(result["market_revision"], "2");
    let mut expected = vec![json!("312")];
    expected.extend((302..=311).map(|id| json!(id.to_string())));
    assert_eq!(result["data"]["expired_offer_ids"], Value::Array(expected));
    assert_eq!(
        result["data"]["ignored_offer_ids"]
            .as_array()
            .unwrap()
            .len(),
        13
    );
    let after = contract.view_state().await?;
    assert_eq!(after.len(), 1202);
    let state = borsh::from_slice::<MarketState>(after.get(b"STATE".as_slice()).unwrap())?;
    assert_eq!(
        state
            .pending_offer_ids
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>(),
        [1]
    );
    assert_eq!(
        state
            .merchants
            .iter()
            .map(|m| m.pending_offer_count)
            .collect::<Vec<_>>(),
        [1, 1, 0]
    );
    assert_eq!(state.offers_pruned_through, 212);
    assert_eq!(state.offer_ids.next_id(), 313);
    assert_eq!(state.trade_ids.next_id(), 301);
    assert!(
        state
            .merchants
            .iter()
            .all(|m| m.actions.last_action_id() == 1)
    );
    let repeated: Value = caller
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":ids}))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(repeated["market_revision"], "2");
    assert_eq!(repeated["data"]["expired_offer_ids"], json!([]));
    assert_eq!(contract.view_state().await?, after);
    let expired: Value = contract
        .view("get_offer")
        .args_json(json!({"offer_id":"312"}))
        .await?
        .json()?;
    assert_eq!(expired["data"]["offer"]["status"], "expired");
    assert_eq!(expired["data"]["offer"]["closed_at_ns"], "1");
    assert_eq!(state.market_revision, 2);
    let pruned: Value = contract
        .view("get_offer")
        .args_json(json!({"offer_id":"202"}))
        .await?
        .json()?;
    assert_eq!(pruned["data"], json!({"kind":"pruned","offer_id":"202"}));
    println!(
        "CLEANUP max_input=24 expired=11 gas={gas} storage_after={}",
        contract.view_account().await?.storage_usage
    );
    assert!(gas < 300_000_000_000_000);
    assert!(
        !production
            .windows(b"fill_players".len())
            .any(|window| window == b"fill_players")
    );
    let unavailable = contract
        .call("fill_players")
        .args_json(json!({"count":1}))
        .transact()
        .await?;
    assert!(unavailable.into_result().is_err());
    Ok(())
}
