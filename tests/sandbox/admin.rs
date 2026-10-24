use super::wasm;
use anyhow::Result;
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use std::path::Path;

#[tokio::test]
async fn owner_admin_calls_and_pause_matrix() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    for method in ["pause_market", "resume_market"] {
        let result = contract
            .call(method)
            .args_json(json!({}))
            .transact()
            .await?;
        assert!(result.into_result().is_err());
        assert!(contract.view_state().await?.is_empty());
    }
    let owner = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let controller = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":owner.id(),
        "merchant_controllers":{"rex":controller.id(),"luna":"luna.testnet","bolt":"bolt.testnet"}
    })).transact().await?.into_result()?;
    let seeded = contract.view_state().await?;
    for caller in [&attacker, &controller, contract.as_account()] {
        for method in ["pause_market", "resume_market"] {
            let result = caller
                .call(contract.id(), method)
                .args_json(json!({}))
                .transact()
                .await?;
            assert!(
                result
                    .into_result()
                    .unwrap_err()
                    .to_string()
                    .contains("BB:E_UNAUTHORIZED")
            );
            assert_eq!(contract.view_state().await?, seeded);
        }
    }
    for method in ["pause_market", "resume_market"] {
        for args in [
            json!({"owner_account_id":owner.id()}),
            json!({"paused":true}),
            json!([]),
            json!(null),
            json!({"extra":"x"}),
        ] {
            let result = owner
                .call(contract.id(), method)
                .args_json(args)
                .transact()
                .await?;
            assert!(result.into_result().is_err());
            assert_eq!(contract.view_state().await?, seeded);
        }
        for bytes in [
            b"".to_vec(),
            b"{".to_vec(),
            br#"{"extra":"x","extra":"y"}"#.to_vec(),
        ] {
            let result = owner
                .call(contract.id(), method)
                .args(bytes)
                .transact()
                .await?;
            assert!(result.into_result().is_err());
            assert_eq!(contract.view_state().await?, seeded);
        }
        let result = owner
            .call(contract.id(), method)
            .args_json(json!({}))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?;
        assert!(result.into_result().is_err());
        assert_eq!(contract.view_state().await?, seeded);
    }
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    let proxy = worker.dev_deploy(&fixture).await?;
    for method in ["pause_market", "resume_market"] {
        let result = owner
            .call(proxy.id(), "forward_admin")
            .args_json(json!({
                "contract_id":contract.id(),"method":method
            }))
            .max_gas()
            .transact()
            .await?;
        assert!(
            result
                .into_result()
                .unwrap_err()
                .to_string()
                .contains("BB:E_UNAUTHORIZED")
        );
        assert_eq!(contract.view_state().await?, seeded);
    }
    let unchanged: Value = owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(unchanged["market_revision"], "1");
    assert_eq!(unchanged["data"], json!({"paused":false,"changed":false}));
    assert_eq!(contract.view_state().await?, seeded);
    let paused: Value = owner
        .call(contract.id(), "pause_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(paused["market_revision"], "2");
    assert_eq!(paused["data"], json!({"paused":true,"changed":true}));
    assert!(paused["block_height"].as_str().unwrap().parse::<u64>()? > 0);
    assert!(
        paused["block_timestamp_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            > 0
    );
    let before = contract.view_state().await?;
    let repeated: Value = owner
        .call(contract.id(), "pause_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(repeated["market_revision"], "2");
    assert_eq!(repeated["data"], json!({"paused":true,"changed":false}));
    assert_eq!(contract.view_state().await?, before);
    for method in ["pause_market", "resume_market"] {
        let result = attacker
            .call(contract.id(), method)
            .args_json(json!({}))
            .transact()
            .await?;
        assert!(
            result
                .into_result()
                .unwrap_err()
                .to_string()
                .contains("BB:E_UNAUTHORIZED")
        );
        assert_eq!(contract.view_state().await?, before);
    }
    for (method, args) in [
        ("get_market_state", json!({})),
        ("get_player", json!({"account_id":attacker.id()})),
        ("get_merchant", json!({"merchant_id":"rex"})),
        ("get_offer", json!({"offer_id":"1"})),
        (
            "get_offers_for_merchant",
            json!({"merchant_id":"rex","status":"all","after_id":null,"limit":"50","expected_revision":"2"}),
        ),
        (
            "get_recent_trades",
            json!({"after_id":null,"limit":"50","expected_revision":"2"}),
        ),
    ] {
        let result: Value = contract.view(method).args_json(args).await?.json()?;
        assert_eq!(result["market_revision"], "2");
        assert_eq!(contract.view_state().await?, before);
    }
    let cleanup: Value = attacker
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":["1"]}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(cleanup["market_revision"], "2");
    assert_eq!(
        cleanup["data"],
        json!({"expired_offer_ids":[],"ignored_offer_ids":["1"]})
    );
    assert_eq!(contract.view_state().await?, before);
    let resumed: Value = owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(resumed["market_revision"], "3");
    assert_eq!(resumed["data"], json!({"paused":false,"changed":true}));
    let before = contract.view_state().await?;
    let repeated: Value = owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(repeated["market_revision"], "3");
    assert_eq!(repeated["data"], json!({"paused":false,"changed":false}));
    assert_eq!(contract.view_state().await?, before);
    for method in [
        "seed_market",
        "reset_market",
        "mint",
        "set_owner",
        "set_controller",
        "upgrade",
        "migrate",
        "fill_players",
        "forward_admin",
    ] {
        assert!(
            owner
                .call(contract.id(), method)
                .args_json(json!({}))
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    Ok(())
}

#[tokio::test]
async fn contract_account_can_administer_only_when_it_is_the_owner() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    contract
        .call("initialize_market")
        .args_json(json!({
            "owner_account_id":contract.id(),
            "merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}
        }))
        .transact()
        .await?
        .into_result()?;
    for (method, paused, revision) in [("pause_market", true, "2"), ("resume_market", false, "3")] {
        let result: Value = contract
            .call(method)
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()?
            .json()?;
        assert_eq!(result["data"], json!({"paused":paused,"changed":true}));
        assert_eq!(result["market_revision"], revision);
    }
    Ok(())
}
