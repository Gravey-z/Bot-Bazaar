use super::{canonical, wasm};
use anyhow::Result;
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

async fn view(c: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(c.view(method).args_json(args).await?.json()?)
}
async fn command(c: &Contract, seq: u64) -> Result<Value> {
    let t = view(c, "get_town", json!({})).await?;
    let time = t["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?;
    Ok(
        json!({"sequence":seq.to_string(),"config_version":"1","valid_until_ns":(time+500_000_000_000).to_string()}),
    )
}
async fn reject_raw(c: &Contract, a: &Account, method: &str, raw: Vec<u8>) -> Result<()> {
    let before = c.view_state().await?;
    let failed = a
        .call(c.id(), method)
        .args(raw)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(
        failed.is_failure(),
        "hostile {method} unexpectedly succeeded"
    );
    assert_eq!(
        c.view_state().await?,
        before,
        "hostile {method} modified state"
    );
    Ok(())
}

#[tokio::test]
async fn hostile_wire_names_deposits_and_registered_owner_spoofing_are_atomic() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let victim = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let mut forged = json!({"command":command(&c,1).await?});
    forged["owner_account_id"] = json!(victim.id());
    reject_raw(
        &c,
        &attacker,
        "register_player",
        serde_json::to_vec(&forged)?,
    )
    .await?;
    for a in [&victim, &attacker] {
        a.call(c.id(), "register_player")
            .args_json(json!({"command":command(&c,1).await?}))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    let cmd = command(&c, 2).await?;
    let normal = json!({"name":"Independent","command":cmd});
    let duplicate_name = format!(r#"{{"name":"First","name":"Second","command":{cmd}}}"#);
    reject_raw(&c, &attacker, "create_shop", duplicate_name.into_bytes()).await?;
    for mutate in 0..8 {
        let mut bad = normal.clone();
        match mutate {
            0 => bad["name"] = json!("A".repeat(8193)),
            1 => bad["name"] = json!("A\nB"),
            2 => bad["name"] = json!("A\u{200b}B"),
            3 => bad["owner_account_id"] = json!(victim.id()),
            4 => bad["command"]["sequence"] = json!(2),
            5 => bad["command"]["sequence"] = json!("02"),
            6 => bad["command"]["sequence"] = json!("18446744073709551616"),
            _ => bad["command"]["owner_account_id"] = json!(victim.id()),
        }
        reject_raw(&c, &attacker, "create_shop", serde_json::to_vec(&bad)?).await?;
    }
    let before = c.view_state().await?;
    let deposited = attacker
        .call(c.id(), "create_shop")
        .args_json(normal)
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(deposited.is_failure());
    assert_eq!(c.view_state().await?, before);
    let first: Value = victim
        .call(c.id(), "create_shop")
        .args_json(json!({"name":"X".repeat(32),"command":command(&c,2).await?}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(first["data"]["outcome"]["shop"]["shop_id"], "4");
    let rename = json!({"shop_id":"4","expected_shop_revision":"1","name":"Stolen","command":command(&c,2).await?});
    reject_raw(&c, &attacker, "rename_shop", serde_json::to_vec(&rename)?).await?;
    for name in [
        "Y".repeat(33),
        "Bad\0Name".to_owned(),
        "<script>".to_owned(),
    ] {
        let bad = json!({"shop_id":"4","expected_shop_revision":"1","name":name,"command":command(&c,3).await?});
        reject_raw(&c, &victim, "rename_shop", serde_json::to_vec(&bad)?).await?;
    }
    victim.call(c.id(), "rename_shop")
        .args_json(json!({"shop_id":"4","expected_shop_revision":"1","name":"Y".repeat(32),"command":command(&c,3).await?}))
        .gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    attacker
        .call(c.id(), "create_shop")
        .args_json(json!({"name":"Independent","command":command(&c,2).await?}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    for (a, id) in [(&victim, "4"), (&attacker, "5")] {
        let player = view(&c, "get_player", json!({"account_id":a.id()})).await?;
        assert_eq!(player["data"]["shop_id"], id);
        assert_eq!(player["data"]["ledger"]["gold"]["held"], "100");
        let shop = view(&c, "get_shop", json!({"shop_id":id})).await?;
        assert_eq!(shop["data"]["owner"]["account_id"], a.id().as_str());
    }
    let town = view(&c, "get_town", json!({})).await?;
    assert_eq!(town["data"]["totals"]["player_grants"], "200");
    assert_eq!(town["data"]["next_shop_id"], "6");
    println!(
        "ADVERSARIAL_WASM hostile_calls_atomic=true exact_name_limit=32 independent_shops=2 grants=200"
    );
    Ok(())
}
