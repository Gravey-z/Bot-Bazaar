use super::wasm;
use anyhow::Result;
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use std::path::Path;

fn fixture() -> Result<Vec<u8>> {
    Ok(std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?)
}

#[tokio::test]
async fn public_registration_identity_grants_and_rejections() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let player = worker.dev_create_account().await?;
    assert!(
        player
            .call(contract.id(), "register_player")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert!(contract.view_state().await?.is_empty());
    let owner = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let second = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}
    })).transact().await?.into_result()?;
    let seed: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    let registered = player
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let gas = registered.total_gas_burnt.as_gas();
    let result: Value = registered.json()?;
    let expected = json!({"account_id":player.id(),"gold":"100","inventory":{"crystal":"0","wood":"0","herb":"0","iron":"0"}});
    assert_eq!(result["market_revision"], "2");
    assert!(result["block_height"].as_str().unwrap().parse::<u64>()? > 0);
    assert!(
        result["block_timestamp_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            > 0
    );
    assert_eq!(result["data"], expected);
    let lookup: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":player.id()}))
        .await?
        .json()?;
    assert_eq!(lookup["data"], expected);
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(market["data"]["registered_player_count"], "1");
    assert_eq!(market["data"]["total_issued_gold"], "650");
    assert_eq!(
        market["data"]["resource_supply"],
        seed["data"]["resource_supply"]
    );
    assert_eq!(market["data"]["merchants"], seed["data"]["merchants"]);
    let before = contract.view_state().await?;
    assert_eq!(before.len(), 2);
    let duplicate = player
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(
        duplicate
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_ALREADY_REGISTERED")
    );
    assert_eq!(contract.view_state().await?, before);
    for caller in [contract.as_account(), &owner, &rex, &luna, &bolt] {
        let result = caller
            .call(contract.id(), "register_player")
            .args_json(json!({}))
            .transact()
            .await?;
        assert!(
            result
                .into_result()
                .unwrap_err()
                .to_string()
                .contains("BB:E_RESERVED_ACCOUNT")
        );
        assert_eq!(contract.view_state().await?, before);
        let lookup: Value = contract
            .view("get_player")
            .args_json(json!({"account_id":caller.id()}))
            .await?
            .json()?;
        assert!(lookup["data"].is_null());
    }
    for args in [
        json!({"account_id":player.id()}),
        json!({"gold":"100"}),
        json!({"extra":null}),
        json!([]),
        json!(null),
        json!(false),
        json!(""),
    ] {
        assert!(
            second
                .call(contract.id(), "register_player")
                .args_json(args)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    for bytes in [
        b"".to_vec(),
        b"{".to_vec(),
        br#"{"account_id":"one.testnet","account_id":"two.testnet"}"#.to_vec(),
    ] {
        assert!(
            second
                .call(contract.id(), "register_player")
                .args(bytes)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    assert!(
        second
            .call(contract.id(), "register_player")
            .args_json(json!({}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    owner
        .call(contract.id(), "pause_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let paused = contract.view_state().await?;
    let result = second
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(
        result
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_MARKET_PAUSED")
    );
    assert_eq!(contract.view_state().await?, paused);
    owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let result: Value = second
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(result["market_revision"], "5");
    assert_eq!(result["data"]["gold"], "100");
    let proxy = worker.dev_deploy(&fixture()?).await?;
    let forwarded: Value = player
        .call(proxy.id(), "forward_registration")
        .args_json(json!({"contract_id":contract.id()}))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(forwarded["data"]["account_id"], proxy.id().as_str());
    assert_eq!(forwarded["data"]["gold"], "100");
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(market["data"]["registered_player_count"], "3");
    assert_eq!(market["data"]["total_issued_gold"], "850");
    assert_eq!(market["market_revision"], "6");
    let lookup: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":player.id()}))
        .await?
        .json()?;
    assert_eq!(lookup["data"], expected);
    let before = contract.view_state().await?;
    let repeated = player
        .call(proxy.id(), "forward_registration")
        .args_json(json!({"contract_id":contract.id()}))
        .max_gas()
        .transact()
        .await?;
    assert!(
        repeated
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_ALREADY_REGISTERED")
    );
    assert_eq!(contract.view_state().await?, before);
    assert!(
        player
            .call(contract.id(), "forward_registration")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    println!("REGISTRATION gas={gas}");
    Ok(())
}

#[tokio::test]
async fn public_registration_final_slot_and_permanent_grant_after_history_eviction() -> Result<()> {
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
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":contract.id(),"merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}
    })).transact().await?.into_result()?;
    let fixture = fixture()?;
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&fixture)
        .transact()
        .await?
        .into_result()?;
    for count in [100, 100, 100, 100, 100, 100, 100, 100, 100, 99] {
        contract
            .call("fill_players")
            .args_json(json!({"count":count}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&production)
        .transact()
        .await?
        .into_result()?;
    let last = worker.dev_create_account().await?;
    let extra = worker.dev_create_account().await?;
    let storage_before_last = contract.view_account().await?.storage_usage;
    let final_registration = last
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .gas(near_workspaces::types::Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    let gas = final_registration.total_gas_burnt.as_gas();
    let result: Value = final_registration.json()?;
    let storage_delta = contract.view_account().await?.storage_usage - storage_before_last;
    assert!(gas < 30_000_000_000_000);
    println!(
        "LIMIT_REGISTRATION players=1000 issued_gold=100550 gas={gas} added_bytes={storage_delta}"
    );
    assert_eq!(result["data"]["gold"], "100");
    assert_eq!(result["market_revision"], "2");
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(market["data"]["registered_player_count"], "1000");
    assert_eq!(market["data"]["total_issued_gold"], "100550");
    let before = contract.view_state().await?;
    assert_eq!(before.len(), 1001);
    let result = extra
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(
        result
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_PLAYER_CAPACITY")
    );
    assert_eq!(contract.view_state().await?, before);
    let result = last
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(
        result
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_ALREADY_REGISTERED")
    );
    assert_eq!(contract.view_state().await?, before);
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&fixture)
        .transact()
        .await?
        .into_result()?;
    for _ in 0..11 {
        contract
            .call("fill_history")
            .args_json(json!({"count":10}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&production)
        .transact()
        .await?
        .into_result()?;
    let before = contract.view_state().await?;
    let result = last
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(
        result
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_ALREADY_REGISTERED")
    );
    assert_eq!(contract.view_state().await?, before);
    let lookup: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":last.id()}))
        .await?
        .json()?;
    assert_eq!(lookup["data"]["gold"], "100");
    let pruned: Value = contract
        .view("get_offer")
        .args_json(json!({"offer_id":"2"}))
        .await?
        .json()?;
    assert_eq!(pruned["data"]["kind"], "pruned");
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(market["data"]["total_issued_gold"], "100550");
    assert_eq!(market["market_revision"], "2");
    Ok(())
}
