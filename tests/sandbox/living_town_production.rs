use super::living_town_adapter::rpc;
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
pub(super) async fn view(c: &Contract, m: &str, args: Value) -> Result<Value> {
    Ok(c.view(m).args_json(args).await?.json()?)
}
pub(super) async fn command(c: &Contract, seq: u64) -> Result<Value> {
    let t = view(c, "get_town", json!({})).await?;
    Ok(
        json!({"sequence":seq.to_string(),"config_version":"1","valid_until_ns":(t["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?+500_000_000_000).to_string()}),
    )
}
pub(super) async fn reject(
    c: &Contract,
    a: &Account,
    m: &str,
    args: Value,
    code: &str,
) -> Result<()> {
    let before = c.view_state().await?;
    let r = a
        .call(c.id(), m)
        .args_json(args)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result();
    let error = match r {
        Ok(_) => anyhow::bail!("Expected {m} to fail with {code}, but it succeeded"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains(code), "expected {code}, got {error}");
    assert_eq!(c.view_state().await?, before);
    Ok(())
}
pub(super) fn base64(bytes: &[u8]) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        s.push(alphabet[((n >> 18) & 63) as usize] as char);
        s.push(alphabet[((n >> 12) & 63) as usize] as char);
        s.push(if c.len() > 1 {
            alphabet[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            alphabet[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    s
}
pub(super) fn pinned(
    url: &str,
    c: &Contract,
    block: &Value,
    m: &str,
    args: Value,
) -> Result<Value> {
    let r = rpc(
        url,
        "query",
        json!({"request_type":"call_function","account_id":c.id(),"block_id":block["header"]["hash"],"method_name":m,"args_base64":base64(&serde_json::to_vec(&args)?)}),
    )?;
    let bytes: Vec<u8> = serde_json::from_value(r["result"].clone())?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub(super) fn snapshot(url: &str, c: &Contract) -> Result<Value> {
    let block = rpc(url, "block", json!({"finality":"final"}))?;
    let town = pinned(url, c, &block, "get_town", json!({}))?;
    let mut shops = Vec::new();
    for id in ["4", "5"] {
        shops.push(json!({"shop":pinned(url,c,&block,"get_shop",json!({"shop_id":id}))?,"ledger":pinned(url,c,&block,"get_shop_inventory",json!({"shop_id":id}))?,"jobs":pinned(url,c,&block,"get_production_jobs",json!({"shop_id":id,"status":"all","after_id":null,"limit":"50","expected_market_revision":town["market_revision"]}))?}));
    }
    Ok(json!({"block":block,"town":town,"shops":shops}))
}
async fn capture(url: &str, c: &Contract, a: &Account, args: Value) -> Result<Value> {
    let t = view(c, "get_town", json!({})).await?;
    let result = a
        .call(c.id(), "start_production")
        .args_json(args.clone())
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(result.is_success());
    let hash = result.outcome().transaction_hash.to_string();
    let receipt = rpc(
        url,
        "tx",
        json!({"tx_hash":hash,"sender_account_id":a.id(),"wait_until":"FINAL"}),
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
    let block = rpc(url, "block", json!({"block_id":executed["block_hash"]}))?;
    let account = rpc(
        url,
        "query",
        json!({"request_type":"view_account","account_id":c.id(),"block_id":executed["block_hash"]}),
    )?;
    let foundation = pinned(url, c, &block, "get_foundation", json!({}))?;
    Ok(
        json!({"method":"start_production","args":args,"signer_id":a.id(),"transaction_hash":hash,"reference_block_height":t["block_height"],"gas_burnt":result.total_gas_burnt.as_gas().to_string(),"receipt":receipt,"block":block,"account":account,"foundation":foundation}),
    )
}

#[tokio::test]
async fn starts_consume_real_inputs_once_pin_jobs_and_rollback_storage_failure() -> Result<()> {
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
    let empty = json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"1","expected_shop_revision":"1","command":command(&c,3).await?});
    reject(
        &c,
        &a,
        "start_production",
        empty.clone(),
        "LT:E_INSUFFICIENT_INPUTS",
    )
    .await?;
    reject(&c, &b, "start_production", empty, "LT:E_NOT_OWNER").await?;
    for (player, seq, m, item, q, price) in [
        (&a, 3, "rex", "crystal", "3", "12"),
        (&a, 4, "luna", "herb", "6", "18"),
        (&b, 3, "bolt", "wood", "2", "4"),
        (&b, 4, "bolt", "iron", "4", "20"),
    ] {
        player.call(c.id(),"buy_from_merchant").args_json(json!({"merchant_id":m,"item_id":item,"quantity":q,"expected_listing_revision":"1","max_total_price":price,"command":command(&c,seq).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    }
    let args = json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"3","expected_shop_revision":"1","command":command(&c,5).await?});
    for (field, value, code) in [
        ("quantity", "0", "LT:E_INVALID_QUANTITY"),
        ("quantity", "11", "LT:E_INVALID_QUANTITY"),
        ("recipe_version", "2", "LT:E_UNKNOWN_RECIPE_VERSION"),
        ("expected_shop_revision", "2", "LT:E_STALE_SHOP"),
    ] {
        let mut bad = args.clone();
        bad[field] = json!(value);
        reject(&c, &a, "start_production", bad, code).await?;
    }
    let before = snapshot(&url, &c)?;
    let first = capture(&url, &c, &a, args.clone()).await?;
    let stored = c.view_state().await?;
    let replay = capture(&url, &c, &a, args.clone()).await?;
    assert_eq!(c.view_state().await?, stored);
    let mut conflict = args.clone();
    conflict["quantity"] = json!("2");
    reject(
        &c,
        &a,
        "start_production",
        conflict,
        "LT:E_COMMAND_CONFLICT",
    )
    .await?;
    let mut slot = args.clone();
    slot["command"] = command(&c, 6).await?;
    slot["expected_shop_revision"] = json!("2");
    reject(&c, &a, "start_production", slot, "LT:E_NO_PRODUCTION_SLOT").await?;
    let pending = json!({"shop_id":"5","recipe_id":"iron_tool","recipe_version":"1","quantity":"2","expected_shop_revision":"1","command":command(&c,5).await?});
    // Keep native stake but remove the additional admission headroom. A failure
    // after root/map flush must revert job/slot/ledger/totals/command together.
    let native = c.view_account().await?;
    let keep =
        u128::from(native.storage_usage) * near_sdk::env::storage_byte_cost().as_yoctonear() * 11
            / 10;
    c.as_account()
        .transfer_near(
            b.id(),
            near_workspaces::types::NearToken::from_yoctonear(native.balance.as_yoctonear() - keep),
        )
        .await?
        .into_result()?;
    reject(
        &c,
        &b,
        "start_production",
        pending.clone(),
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    b.transfer_near(c.id(), near_workspaces::types::NearToken::from_near(1))
        .await?
        .into_result()?;
    let second = capture(&url, &c, &b, pending).await?;
    let after = snapshot(&url, &c)?;
    assert_eq!(after["town"]["data"]["next_job_id"], "3");
    assert_eq!(
        after["town"]["data"]["totals"]["recipe_inputs_consumed"],
        json!({"crystal":"3","wood":"2","herb":"6","iron":"4","health_potion":"0","iron_tool":"0"})
    );
    for (i, item, q, seconds) in [
        (0, "health_potion", "3", 360u64),
        (1, "iron_tool", "2", 360u64),
    ] {
        let job = &after["shops"][i]["jobs"]["data"]["items"][0];
        assert_eq!(job["quantity"], q);
        assert_eq!(job["status"], "running");
        assert_eq!(job["recipe_version"], "1");
        assert_eq!(
            job["ready_at_ns"].as_str().unwrap().parse::<u64>()?
                - job["start_at_ns"].as_str().unwrap().parse::<u64>()?,
            seconds * 1_000_000_000
        );
        let inv = &after["shops"][i]["ledger"]["data"]["inventory"];
        assert_eq!(inv["held"][item], "0");
        assert_eq!(inv["production_output_reserved"][item], q);
    }
    println!(
        "PRODUCTION_SANDBOX={}",
        json!({"source":"actual disposable local WASM sandbox; synthetic declared genesis; not Testnet","contract_id":c.id(),"before":before,"after":after,"steps":[first,replay,second]})
    );
    Ok(())
}

#[tokio::test]
async fn concurrent_conflicting_starts_admit_one_batch_and_preserve_losing_state() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    let a = worker.dev_create_account().await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    a.call(c.id(), "register_player")
        .args_json(json!({"command":command(&c,1).await?}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    a.call(c.id(), "create_shop")
        .args_json(json!({"name":"Start Race","command":command(&c,2).await?}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    for (seq, merchant, item, q, cost) in [
        (3, "rex", "crystal", "2", "8"),
        (4, "luna", "herb", "4", "12"),
    ] {
        a.call(c.id(),"buy_from_merchant").args_json(json!({"merchant_id":merchant,"item_id":item,"quantity":q,"expected_listing_revision":"1","max_total_price":cost,"command":command(&c,seq).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    }
    let one = json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"1","expected_shop_revision":"1","command":command(&c,5).await?});
    let mut two = one.clone();
    two["quantity"] = json!("2");
    let before = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    let (left, right) = tokio::join!(
        a.call(c.id(), "start_production")
            .args_json(one.clone())
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact(),
        a.call(c.id(), "start_production")
            .args_json(two.clone())
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
    );
    let results = [left?.into_result(), right?.into_result()];
    ensure!(
        results.iter().filter(|r| r.is_ok()).count() == 1,
        "exactly one finalized Start must win"
    );
    let winner = results.iter().position(|r| r.is_ok()).unwrap();
    let q = if winner == 0 { 1u64 } else { 2 };
    for error in results.iter().filter_map(|r| r.as_ref().err()) {
        ensure!(error.to_string().contains("LT:E_COMMAND_CONFLICT"));
    }
    let result: Value = results[winner].as_ref().unwrap().json()?;
    assert_eq!(result["data"]["replayed"], false);
    let after = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    let inventory = &after["data"]["inventory"];
    assert_eq!(after["data"]["gold"], before["data"]["gold"]);
    for (item, held) in [
        ("crystal", 2 - q),
        ("herb", 4 - 2 * q),
        ("wood", 0),
        ("iron", 0),
        ("health_potion", 0),
        ("iron_tool", 0),
    ] {
        assert_eq!(inventory["held"][item], held.to_string());
    }
    assert_eq!(
        inventory["production_output_reserved"]["health_potion"],
        q.to_string()
    );
    for field in [
        "listing_reserved",
        "trade_reserved",
        "trade_inbound_reserved",
    ] {
        assert_eq!(inventory[field], before["data"]["inventory"][field]);
    }
    let town = view(&c, "get_town", json!({})).await?;
    assert_eq!(town["data"]["next_job_id"], "2");
    assert_eq!(
        town["data"]["totals"]["recipe_inputs_consumed"]["crystal"],
        q.to_string()
    );
    assert_eq!(
        town["data"]["totals"]["recipe_inputs_consumed"]["herb"],
        (2 * q).to_string()
    );
    let stable = c.view_state().await?;
    let replay: Value = a
        .call(c.id(), "start_production")
        .args_json(if winner == 0 {
            one.clone()
        } else {
            two.clone()
        })
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(replay["data"]["replayed"], true);
    assert_eq!(c.view_state().await?, stable);
    let mut new = one;
    new["command"] = command(&c, 6).await?;
    new["expected_shop_revision"] = json!("2");
    reject(&c, &a, "start_production", new, "LT:E_NO_PRODUCTION_SLOT").await?;
    println!(
        "PRODUCTION_FAULT_RACE finalized_calls=2 applied=1 command_conflicts=1 jobs=1 consumed_batches=1 replay_unchanged=true slot_rejection_unchanged=true"
    );
    Ok(())
}
