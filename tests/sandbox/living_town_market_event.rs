use super::living_town_adapter::rpc;
use super::living_town_production::{command, pinned, reject, view};
use super::living_town_sales_races::call as capture_call;
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};

async fn call(url: &str, c: &Contract, a: &Account, method: &str, args: Value) -> Result<Value> {
    let r = capture_call(url, c, a, method, args).await?;
    ensure!(r["succeeded"] == true, "{method}: {}", r["error"]);
    Ok(r)
}
async fn boundary(w: &Worker<Sandbox>, c: &Contract, target: u64) -> Result<Value> {
    for _ in 0..100 {
        let t = view(c, "get_town", json!({})).await?;
        let epoch = t["data"]["epoch"].as_str().unwrap().parse::<u64>()?;
        if epoch >= target {
            ensure!(epoch == target, "missed target boundary");
            return Ok(t);
        }
        w.fast_forward(10).await?;
    }
    anyhow::bail!("boundary unavailable")
}
#[tokio::test]
async fn herb_shortage_announces_once_limits_real_supply_and_expires_without_balance_reset()
-> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let w = near_workspaces::sandbox().await?;
    let c = w.dev_deploy(&wasm()?).await?;
    let op = w.dev_create_account().await?;
    let luna = w.dev_create_account().await?;
    let rex = w.dev_create_account().await?;
    let bolt = w.dev_create_account().await?;
    let player = w.dev_create_account().await?;
    let url = w.rpc_addr();
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":op.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let mut steps = Vec::new();
    steps.push(
        call(
            &url,
            &c,
            &player,
            "register_player",
            json!({"command":command(&c,1).await?}),
        )
        .await?,
    );
    let purchase = |revision: &str, seq: u64| {
        json!({
            "merchant_id": "luna",
            "item_id": "herb",
            "quantity": "8",
            "expected_listing_revision": revision,
            "max_total_price": "24",
            "command": {
                "sequence": seq.to_string(),
                "config_version": "1",
                "valid_until_ns": "0"
            }
        })
    };
    let mut buy = purchase("1", 2);
    buy["command"] = command(&c, 2).await?;
    steps.push(call(&url, &c, &player, "buy_from_merchant", buy).await?);
    let t = view(&c, "get_town", json!({})).await?;
    let current = t["data"]["epoch"].as_str().unwrap().parse::<u64>()?;
    let start = current + 1;
    let end = start + 5;
    let schedule = json!({"event_id":"1","definition_id":"herb_shortage_v1","start_epoch":start.to_string(),"command":command(&c,1).await?});
    reject(
        &c,
        &player,
        "schedule_market_event",
        schedule.clone(),
        "LT:E_UNAUTHORIZED",
    )
    .await?;
    let mut bad = schedule.clone();
    bad["definition_id"] = json!("unbounded_surplus");
    reject(
        &c,
        &op,
        "schedule_market_event",
        bad,
        "LT:E_EVENT_DEFINITION",
    )
    .await?;
    steps.push(call(&url, &c, &op, "schedule_market_event", schedule.clone()).await?);
    steps.push(call(&url, &c, &op, "schedule_market_event", schedule.clone()).await?);
    let mut overlap = schedule.clone();
    overlap["event_id"] = json!("2");
    overlap["command"] = command(&c, 2).await?;
    reject(
        &c,
        &op,
        "schedule_market_event",
        overlap,
        "LT:E_EVENT_PENDING",
    )
    .await?;
    let mut checkpoints = Vec::new();
    let capture = || -> Result<Value> {
        let b = rpc(&url, "block", json!({"finality":"final"}))?;
        Ok(
            json!({"block":b,"town":pinned(&url,&c,&b,"get_town",json!({}))?,"events":pinned(&url,&c,&b,"get_market_events",json!({}))?}),
        )
    };
    checkpoints.push(capture()?);
    boundary(&w, &c, start).await?;
    let raw = json!({"item_id":"herb","epoch":start.to_string(),"command":command(&c,2).await?});
    steps.push(call(&url, &c, &op, "allocate_raw_supply", raw.clone()).await?);
    assert_eq!(
        steps.last().unwrap()["effect"]["data"]["outcome"]["issued_quantity"],
        "4"
    );
    checkpoints.push(capture()?);
    // Relist and buy replenished stock through ordinary controller/player authority.
    steps.push(call(&url,&c,&luna,"set_listing",json!({"shop_id":"2","item_id":"herb","quantity":"4","unit_price":"3","expected_listing_revision":"2","command":command(&c,1).await?})).await?);
    let mut buy = purchase("3", 3);
    buy["command"] = command(&c, 3).await?;
    buy["quantity"] = json!("4");
    buy["max_total_price"] = json!("12");
    steps.push(call(&url, &c, &player, "buy_from_merchant", buy).await?);
    boundary(&w, &c, end - 1).await?;
    steps.push(
        call(
            &url,
            &c,
            &op,
            "allocate_raw_supply",
            json!({"item_id":"herb","epoch":(end-1).to_string(),"command":command(&c,3).await?}),
        )
        .await?,
    );
    assert_eq!(
        steps.last().unwrap()["effect"]["data"]["outcome"]["issued_quantity"],
        "4"
    );
    checkpoints.push(capture()?);
    boundary(&w, &c, end).await?;
    let before = view(&c, "get_town", json!({})).await?;
    steps.push(
        call(
            &url,
            &c,
            &op,
            "allocate_raw_supply",
            json!({"item_id":"herb","epoch":end.to_string(),"command":command(&c,4).await?}),
        )
        .await?,
    );
    assert_eq!(
        steps.last().unwrap()["effect"]["data"]["outcome"]["issued_quantity"],
        "8"
    );
    checkpoints.push(capture()?);
    reject(
        &c,
        &op,
        "schedule_market_event",
        schedule.clone(),
        "LT:E_COMMAND_PRUNED",
    )
    .await?;
    let final_town = view(&c, "get_town", json!({})).await?;
    assert_eq!(before["data"]["totals"]["supplied_items"]["herb"], "8");
    assert_eq!(final_town["data"]["totals"]["supplied_items"]["herb"], "16");
    assert_eq!(final_town["data"]["next_market_event_id"], "2");
    ensure!(
        steps.iter().all(|s| s["succeeded"] == true),
        "unexpected failed step"
    );
    println!(
        "MARKET_EVENT_SANDBOX={}",
        json!({"source":"actual disposable local WASM; accelerated chain time; not Testnet or live event execution","steps":steps,"checkpoints":checkpoints,"before_expired_allocation":before,"after":final_town})
    );
    Ok(())
}
