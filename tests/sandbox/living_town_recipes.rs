use super::living_town_adapter::rpc;
use super::{canonical, wasm};
use anyhow::Result;
use serde_json::{Value, json};

#[tokio::test]
async fn immutable_recipes_are_exact_paged_read_only_and_revision_bound() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let before = c.view_state().await?;
    let args = json!({"after_id":null,"limit":"1","expected_market_revision":"1"});
    let first: Value = c
        .view("get_recipes")
        .args_json(args.clone())
        .await?
        .json()?;
    assert_eq!(
        first["data"]["items"][0]["recipe"]["recipe_id"],
        "health_potion"
    );
    assert_eq!(
        first["data"]["items"][0]["recipe"]["duration_seconds"],
        "120"
    );
    assert_eq!(first["data"]["items"][0]["recipe"]["inputs"]["herb"], "2");
    assert_eq!(first["data"]["has_more"], true);
    let second: Value = c
        .view("get_recipes")
        .args_json(json!({"after_id":"1","limit":"1","expected_market_revision":"1"}))
        .await?
        .json()?;
    assert_eq!(
        second["data"]["items"][0]["recipe"]["recipe_id"],
        "iron_tool"
    );
    assert_eq!(
        second["data"]["items"][0]["recipe"]["duration_seconds"],
        "180"
    );
    assert_eq!(second["data"]["has_more"], false);
    let empty: Value = c
        .view("get_recipes")
        .args_json(json!({"after_id":"2","limit":"50","expected_market_revision":"1"}))
        .await?
        .json()?;
    assert_eq!(empty["data"]["items"], json!([]));
    assert_eq!(empty["data"]["next_after_id"], "2");
    for (key, value) in [
        ("limit", json!("0")),
        ("limit", json!("51")),
        ("limit", json!("1.5")),
        ("limit", json!(1)),
        ("after_id", json!("01")),
        ("recipe_id", json!("unknown")),
        ("expected_market_revision", json!("2")),
    ] {
        let mut bad = args.clone();
        bad[key] = value;
        assert!(c.view("get_recipes").args_json(bad).await.is_err());
    }
    assert_eq!(c.view_state().await?, before);
    let url = worker.rpc_addr();
    let block = rpc(&url, "block", json!({"finality":"final"}))?;
    let query = |kind: &str, method: &str, encoded: &str| {
        rpc(
            &url,
            "query",
            json!({"request_type":kind,"account_id":c.id(),"block_id":block["header"]["hash"],"method_name":method,"args_base64":encoded}),
        )
    };
    let recipes = query(
        "call_function",
        "get_recipes",
        "eyJhZnRlcl9pZCI6bnVsbCwibGltaXQiOiIyIiwiZXhwZWN0ZWRfbWFya2V0X3JldmlzaW9uIjoiMSJ9",
    )?;
    let foundation = query("call_function", "get_foundation", "e30=")?;
    let account = rpc(
        &url,
        "query",
        json!({"request_type":"view_account","account_id":c.id(),"block_id":block["header"]["hash"]}),
    )?;
    println!(
        "RECIPE_SANDBOX={}",
        json!({"source":"actual local WASM sandbox; synthetic declared genesis; not Testnet","contract_id":c.id(),"block":block,"account":account,"foundation":foundation,"recipes":recipes})
    );
    let player = worker.dev_create_account().await?;
    let town: Value = c.view("get_town").args_json(json!({})).await?.json()?;
    let now = town["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    player.call(c.id(),"register_player").args_json(json!({"command":{"sequence":"1","config_version":"1","valid_until_ns":(now+500_000_000_000).to_string()}})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    assert!(c.view("get_recipes").args_json(args).await.is_err());
    Ok(())
}
