use super::living_town_adapter::rpc;
use super::living_town_production::{command, pinned, reject, snapshot, view};
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

async fn capture(url: &str, c: &Contract, a: &Account, job: &str, success: bool) -> Result<Value> {
    let before = view(c, "get_town", json!({})).await?;
    let args = json!({"job_id":job});
    let result = a
        .call(c.id(), "complete_production")
        .args_json(args.clone())
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(result.is_success() == success);
    let hash = result.outcome().transaction_hash.to_string();
    let gas = result.total_gas_burnt.as_gas().to_string();
    let receipt = rpc(
        url,
        "tx",
        json!({"tx_hash":hash,"sender_account_id":a.id(),"wait_until":"FINAL"}),
    )?;
    let root = receipt["transaction_outcome"]["outcome"]["status"]["SuccessReceiptId"]
        .as_str()
        .unwrap();
    let execution = receipt["receipts_outcome"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == root)
        .unwrap();
    let block = rpc(url, "block", json!({"block_id":execution["block_hash"]}))?;
    let account = rpc(
        url,
        "query",
        json!({"request_type":"view_account","account_id":c.id(),"block_id":execution["block_hash"]}),
    )?;
    let foundation = pinned(url, c, &block, "get_foundation", json!({}))?;
    let decoded = if success {
        result.into_result()?.json::<Value>()?
    } else {
        Value::Null
    };
    Ok(
        json!({"method":"complete_production","args":args,"signer_id":a.id(),"transaction_hash":hash,"reference_block_height":before["block_height"],"gas_burnt":gas,"receipt":receipt,"block":block,"account":account,"foundation":foundation,"result":decoded}),
    )
}

#[tokio::test]
async fn permissionless_completion_is_rewardless_exact_once_and_cannot_release_a_later_job()
-> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    let url = worker.rpc_addr();
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let a = worker.dev_create_account().await?;
    let b = worker.dev_create_account().await?;
    let keeper = worker.dev_create_account().await?;
    for (player, name) in [(&a, "Potions"), (&b, "Tools")] {
        player
            .call(c.id(), "register_player")
            .args_json(json!({"command":command(&c,1).await?}))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        player
            .call(c.id(), "create_shop")
            .args_json(json!({"name":name,"command":command(&c,2).await?}))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    for (player, seq, m, item, q, price) in [
        (&a, 3, "rex", "crystal", "1", "4"),
        (&a, 4, "luna", "herb", "2", "6"),
        (&b, 3, "bolt", "wood", "1", "2"),
        (&b, 4, "bolt", "iron", "2", "10"),
    ] {
        player.call(c.id(),"buy_from_merchant").args_json(json!({"merchant_id":m,"item_id":item,"quantity":q,"expected_listing_revision":"1","max_total_price":price,"command":command(&c,seq).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    }
    for (player, id, recipe) in [(&a, "4", "health_potion"), (&b, "5", "iron_tool")] {
        let started = player.call(c.id(),"start_production").args_json(json!({"shop_id":id,"recipe_id":recipe,"recipe_version":"1","quantity":"1","expected_shop_revision":"1","command":command(&c,5).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?;
        let hash = started.outcome().transaction_hash.to_string();
        started.into_result()?;
        rpc(
            &url,
            "tx",
            json!({"tx_hash":hash,"sender_account_id":player.id(),"wait_until":"FINAL"}),
        )?;
    }
    let before = snapshot(&url, &c)?;
    let stored = c.view_state().await?;
    let early = capture(&url, &c, &keeper, "1", false).await?;
    assert_eq!(c.view_state().await?, stored);
    let cancellation = keeper
        .call(c.id(), "cancel_production")
        .args_json(json!({"job_id":"1"}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result();
    assert!(
        cancellation
            .unwrap_err()
            .to_string()
            .contains("MethodNotFound")
    );
    assert_eq!(c.view_state().await?, stored);
    println!(
        "LIFECYCLE_POLICY cancellation_absent=true no_refund=true running_promises_unchanged=true"
    );
    for (args, code) in [
        (json!({"job_id":"999"}), "LT:E_JOB_NOT_FOUND"),
        (json!({"job_id":"0"}), "LT:E_INVALID_ARGUMENT"),
        (
            json!({"job_id":"1","owner_account_id":keeper.id()}),
            "LT:E_INVALID_ARGUMENT",
        ),
    ] {
        reject(&c, &keeper, "complete_production", args, code).await?;
    }
    // Sandbox-only chain-time control. Runtime code never trusts a wall timer.
    let ready = before["shops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            row["jobs"]["data"]["items"][0]["ready_at_ns"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        })
        .max()
        .unwrap();
    for _ in 0..4 {
        let time = view(&c, "get_town", json!({})).await?["block_timestamp_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        if time >= ready {
            break;
        }
        worker.fast_forward(1000).await?;
    }
    let time = view(&c, "get_town", json!({})).await?["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    ensure!(time >= ready);
    // Completion must not require the additional 25% new-admission headroom.
    let native = c.view_account().await?;
    let keep =
        u128::from(native.storage_usage) * near_sdk::env::storage_byte_cost().as_yoctonear() * 11
            / 10;
    c.as_account()
        .transfer_near(
            keeper.id(),
            near_workspaces::types::NearToken::from_yoctonear(native.balance.as_yoctonear() - keep),
        )
        .await?
        .into_result()?;
    let first = capture(&url, &c, &keeper, "1", true).await?;
    let (left, right) = tokio::join!(
        capture(&url, &c, &keeper, "2", true),
        capture(&url, &c, &a, "2", true)
    );
    let left = left?;
    let right = right?;
    assert_ne!(
        left["result"]["data"]["replayed"],
        right["result"]["data"]["replayed"]
    );
    let completed = snapshot(&url, &c)?;
    for (i, item, gold) in [(0, "health_potion", "90"), (1, "iron_tool", "88")] {
        let l = &completed["shops"][i]["ledger"]["data"];
        assert_eq!(l["inventory"]["held"][item], "1");
        assert_eq!(l["inventory"]["production_output_reserved"][item], "0");
        assert_eq!(l["gold"]["held"], gold);
        assert_eq!(
            completed["shops"][i]["jobs"]["data"]["items"][0]["status"],
            "completed"
        );
    }
    assert!(view(&c, "get_player", json!({"account_id":keeper.id()})).await?["data"].is_null());
    keeper
        .transfer_near(c.id(), near_workspaces::types::NearToken::from_near(1))
        .await?
        .into_result()?;
    for (seq, m, item, q, price) in [
        (6, "rex", "crystal", "1", "4"),
        (7, "luna", "herb", "2", "6"),
    ] {
        a.call(c.id(),"buy_from_merchant").args_json(json!({"merchant_id":m,"item_id":item,"quantity":q,"expected_listing_revision":"2","max_total_price":price,"command":command(&c,seq).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    }
    let started = a.call(c.id(),"start_production").args_json(json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"1","expected_shop_revision":"3","command":command(&c,8).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?;
    let hash = started.outcome().transaction_hash.to_string();
    started.into_result()?;
    rpc(
        &url,
        "tx",
        json!({"tx_hash":hash,"sender_account_id":a.id(),"wait_until":"FINAL"}),
    )?;
    let state = c.view_state().await?;
    let replay = capture(&url, &c, &b, "1", true).await?;
    assert_eq!(c.view_state().await?, state);
    assert_eq!(
        replay["result"]["data"]["outcome"],
        first["result"]["data"]["outcome"]
    );
    let after = snapshot(&url, &c)?;
    assert_eq!(after["shops"][0]["jobs"]["data"]["items"][1]["job_id"], "3");
    assert_eq!(
        after["shops"][0]["jobs"]["data"]["items"][1]["status"],
        "running"
    );
    assert_eq!(
        after["shops"][0]["ledger"]["data"]["inventory"]["production_output_reserved"]["health_potion"],
        "1"
    );
    assert_eq!(
        after["town"]["data"]["totals"]["completed_outputs"]["health_potion"],
        "1"
    );
    assert_eq!(
        after["town"]["data"]["totals"]["completed_outputs"]["iron_tool"],
        "1"
    );
    println!(
        "COMPLETION_SANDBOX={}",
        json!({"source":"actual local WASM sandbox with explicit fast-forward; synthetic declared genesis; not Testnet","contract_id":c.id(),"before":before,"completed":completed,"after":after,"steps":[early,first,left,right,replay]})
    );
    Ok(())
}
