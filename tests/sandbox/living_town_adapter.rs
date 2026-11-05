use super::{canonical, wasm};
use anyhow::{Result, ensure};
use serde_json::{Value, json};

// Only the disposable sandbox URL is passed here; never a public RPC or key.
fn rpc(url: &str, method: &str, params: Value) -> Result<Value> {
    ensure!(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"));
    let payload =
        json!({"jsonrpc":"2.0","id":"adapter-fixture","method":method,"params":params}).to_string();
    let result = std::process::Command::new("curl")
        .args([
            "-fsS",
            "--max-time",
            "20",
            "-H",
            "Content-Type: application/json",
            "--data",
            &payload,
            url,
        ])
        .output()?;
    ensure!(result.status.success(), "sandbox fixture RPC failed");
    let body: Value = serde_json::from_slice(&result.stdout)?;
    ensure!(body.get("error").is_none(), "sandbox RPC error: {}", body);
    Ok(body["result"].clone())
}
#[tokio::test]
async fn adapter_captures_real_v2_receipts_and_historical_code_views() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let url = worker.rpc_addr();
    let c = worker.dev_deploy(&wasm()?).await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    let initial_town: Value = c.view("get_town").args_json(json!({})).await?.json()?;
    let initial_block = rpc(
        &url,
        "block",
        json!({"block_id":initial_town["block_height"].as_str().unwrap().parse::<u64>()?}),
    )?;
    let player = worker.dev_create_account().await?;
    let mut steps = Vec::new();
    let mut last_args = Value::Null;
    for i in 0..6 {
        let town: Value = c.view("get_town").args_json(json!({})).await?.json()?;
        let command = json!({"sequence":if i<4 {(i+1).to_string()}else if i==4 {"4".to_owned()}else{"5".to_owned()},"config_version":"1","valid_until_ns":(town["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?+500_000_000_000).to_string()});
        let (method, args) = match i {
            0 => ("register_player", json!({"command":command})),
            1 => (
                "create_shop",
                json!({"name":"Adapter Shop","command":command}),
            ),
            2 => (
                "rename_shop",
                json!({"shop_id":"4","expected_shop_revision":"1","name":"Verified Shop","command":command}),
            ),
            4 => ("buy_from_merchant", last_args.clone()),
            _ => (
                "buy_from_merchant",
                json!({"merchant_id":"rex","item_id":"crystal","quantity":"1","expected_listing_revision":"1","max_total_price":"4","command":command}),
            ),
        };
        let reference =
            rpc(&url, "block", json!({"finality":"final"}))?["header"]["height"].clone();
        let result = player
            .call(c.id(), method)
            .args_json(args.clone())
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?;
        ensure!(result.is_success() == (i != 5));
        let hash = result.outcome().transaction_hash.to_string();
        let receipt = rpc(
            &url,
            "tx",
            json!({"tx_hash":hash,"sender_account_id":player.id(),"wait_until":"FINAL"}),
        )?;
        let root = receipt["transaction_outcome"]["outcome"]["status"]["SuccessReceiptId"]
            .as_str()
            .unwrap();
        let executed = receipt["receipts_outcome"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == root)
            .unwrap();
        let block = rpc(&url, "block", json!({"block_id":executed["block_hash"]}))?;
        let account = rpc(
            &url,
            "query",
            json!({"request_type":"view_account","account_id":c.id(),"block_id":executed["block_hash"]}),
        )?;
        // Empty args base64 is e30=. All calls are pinned to the executing block.
        let foundation = rpc(
            &url,
            "query",
            json!({"request_type":"call_function","account_id":c.id(),"block_id":executed["block_hash"],"method_name":"get_foundation","args_base64":"e30="}),
        )?;
        steps.push(json!({"method":method,"args":args,"transaction_hash":hash,"reference_block_height":reference,"gas_burnt":result.total_gas_burnt.as_gas().to_string(),"receipt":receipt,"block":block,"account":account,"foundation":foundation}));
        if i == 3 {
            last_args = args;
        }
    }
    let final_block = rpc(&url, "block", json!({"finality":"final"}))?;
    let mut final_views = serde_json::Map::new();
    for (method, args) in [
        ("get_town", "e30="),
        ("get_shop", "eyJzaG9wX2lkIjoiNCJ9"),
        ("get_shop_inventory", "eyJzaG9wX2lkIjoiNCJ9"),
    ] {
        let result = rpc(
            &url,
            "query",
            json!({"request_type":"call_function","account_id":c.id(),"block_id":final_block["header"]["hash"],"method_name":method,"args_base64":args}),
        )?;
        let bytes: Vec<u8> = serde_json::from_value(result["result"].clone())?;
        final_views.insert(method.to_owned(), serde_json::from_slice::<Value>(&bytes)?);
    }
    println!(
        "ADAPTER_SANDBOX={}",
        json!({"source":"actual disposable local sandbox; synthetic declared V2 genesis; not Testnet","contract_id":c.id(),"player_id":player.id(),"steps":steps,"initial_town":initial_town,"initial_block":initial_block,"final_views":final_views,"final_block":final_block})
    );
    Ok(())
}
