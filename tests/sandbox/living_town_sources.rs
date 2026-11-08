use super::living_town_production::{command, reject, view};
use super::living_town_sales_races::call as capture_call;
use super::{canonical, wasm};
use anyhow::Result;
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
async fn call(url: &str, c: &Contract, a: &Account, method: &str, args: Value) -> Result<Value> {
    let result = capture_call(url, c, a, method, args).await?;
    anyhow::ensure!(result["succeeded"] == true, "{method}: {}", result["error"]);
    Ok(result)
}
async fn cmd(c: &Contract, a: &Account, lane: Option<&str>) -> Result<Value> {
    let principal = lane
        .map(|l| format!("merchant:{l}"))
        .unwrap_or_else(|| format!("account:{}", a.id()));
    let row = view(
        c,
        "get_command",
        json!({"principal":principal,"sequence":u64::MAX.to_string()}),
    )
    .await?;
    command(c, row["data"]["next_sequence"].as_str().unwrap().parse()?).await
}
async fn listing(c: &Contract, shop: &str, item: &str) -> Result<Value> {
    let t = view(c, "get_town", json!({})).await?;
    let p=view(c,"get_listings",json!({"shop_id":shop,"item_id":item,"active_only":false,"after_id":null,"limit":"50","expected_market_revision":t["market_revision"]})).await?;
    Ok(p["data"]["items"]
        .as_array()
        .unwrap()
        .first()
        .cloned()
        .unwrap_or(Value::Null))
}
#[tokio::test]
async fn persistent_supply_supports_depleted_seed_loops_and_exact_epoch_sources_and_sinks()
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
    let rex = w.dev_create_account().await?;
    let luna = w.dev_create_account().await?;
    let bolt = w.dev_create_account().await?;
    let a = w.dev_create_account().await?;
    let url = w.rpc_addr();
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":op.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let mut steps = Vec::new();
    let mut checkpoints = Vec::new();
    for (method, args) in [
        ("register_player", json!({"command":command(&c,1).await?})),
        (
            "create_shop",
            json!({"name":"Persistent Potions","command":command(&c,2).await?}),
        ),
    ] {
        steps.push(call(&url, &c, &a, method, args).await?);
    }
    super::advance_epoch(&w, &c).await?;
    let t = view(&c, "get_town", json!({})).await?;
    let e = t["data"]["epoch"].clone();
    let first = json!({"item_id":"crystal","epoch":e,"command":cmd(&c,&op,None).await?});
    steps.push(call(&url, &c, &op, "allocate_raw_supply", first.clone()).await?);
    assert_eq!(
        steps.last().unwrap()["effect"]["data"]["outcome"]["issued_quantity"],
        "0"
    );
    steps.push(call(&url, &c, &op, "allocate_raw_supply", first.clone()).await?);
    let mut changed = first.clone();
    changed["item_id"] = json!("wood");
    reject(
        &c,
        &op,
        "allocate_raw_supply",
        changed,
        "LT:E_COMMAND_CONFLICT",
    )
    .await?;
    reject(
        &c,
        &a,
        "allocate_raw_supply",
        first.clone(),
        "LT:E_UNAUTHORIZED",
    )
    .await?;
    reject(
        &c,
        &op,
        "allocate_raw_supply",
        json!({"item_id":"health_potion","epoch":e,"command":cmd(&c,&op,None).await?}),
        "LT:E_RAW_ONLY",
    )
    .await?;
    reject(
        &c,
        &op,
        "allocate_raw_supply",
        json!({"item_id":"crystal","epoch":e,"command":cmd(&c,&op,None).await?}),
        "LT:E_EPOCH_ALLOCATED",
    )
    .await?;
    steps.push(
        call(
            &url,
            &c,
            &op,
            "allocate_raw_supply",
            json!({"item_id":"wood","epoch":e,"command":cmd(&c,&op,None).await?}),
        )
        .await?,
    );
    reject(&c, &op, "allocate_raw_supply", first, "LT:E_COMMAND_PRUNED").await?;
    reject(&c,&op,"allocate_raw_supply",json!({"item_id":"crystal","epoch":(e.as_str().unwrap().parse::<u64>()?-1).to_string(),"command":cmd(&c,&op,None).await?}),"LT:E_EPOCH_MISMATCH").await?;
    let before = view(&c, "get_town", json!({})).await?;
    for round in 0..4 {
        super::advance_epoch(&w, &c).await?;
        for item in ["crystal", "wood", "herb", "iron"] {
            let t = view(&c, "get_town", json!({})).await?;
            steps.push(call(&url,&c,&op,"allocate_raw_supply",json!({"item_id":item,"epoch":t["data"]["epoch"],"command":cmd(&c,&op,None).await?})).await?);
        }
        for (m, account, shop, item, q, price) in [
            ("rex", &rex, "1", "crystal", "3", "4"),
            ("luna", &luna, "2", "herb", "6", "3"),
        ] {
            let l = listing(&c, shop, item).await?;
            steps.push(call(&url,&c,account,"set_listing",json!({"shop_id":shop,"item_id":item,"quantity":q,"unit_price":price,"expected_listing_revision":l["revision"],"command":cmd(&c,account,Some(m)).await?})).await?);
            let l = listing(&c, shop, item).await?;
            steps.push(call(&url,&c,&a,"buy_from_merchant",json!({"merchant_id":m,"item_id":item,"quantity":q,"expected_listing_revision":l["revision"],"max_total_price":if item=="crystal"{"12"}else{"18"},"command":cmd(&c,&a,None).await?})).await?);
        }
        let shop = view(&c, "get_shop", json!({"shop_id":"4"})).await?;
        let start=call(&url,&c,&a,"start_production",json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"3","expected_shop_revision":shop["data"]["revision"],"command":cmd(&c,&a,None).await?})).await?;
        let job = start["effect"]["data"]["outcome"]["job"].clone();
        steps.push(start);
        for _ in 0..6 {
            let t = view(&c, "get_town", json!({})).await?;
            if t["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?
                >= job["ready_at_ns"].as_str().unwrap().parse::<u64>()?
            {
                break;
            }
            w.fast_forward(1000).await?;
        }
        steps.push(
            call(
                &url,
                &c,
                &op,
                "complete_production",
                json!({"job_id":job["job_id"]}),
            )
            .await?,
        );
        let l = listing(&c, "4", "health_potion").await?;
        steps.push(call(&url,&c,&a,"set_listing",json!({"shop_id":"4","item_id":"health_potion","quantity":"2","unit_price":"18","expected_listing_revision":l["revision"],"command":cmd(&c,&a,None).await?})).await?);
        let t = view(&c, "get_town", json!({})).await?;
        steps.push(
            call(
                &url,
                &c,
                &op,
                "fund_customer_budget",
                json!({"epoch":t["data"]["epoch"],"command":cmd(&c,&op,None).await?}),
            )
            .await?,
        );
        for _ in 0..2 {
            let t = view(&c, "get_town", json!({})).await?;
            let l = listing(&c, "4", "health_potion").await?;
            steps.push(call(&url,&c,&op,"settle_customer_purchase",json!({"listing_id":l["listing_id"],"expected_listing_revision":l["revision"],"epoch":t["data"]["epoch"],"max_total_price":"18","command":cmd(&c,&op,None).await?})).await?);
        }
        for merchant in ["rex", "luna", "bolt"] {
            let t = view(&c, "get_town", json!({})).await?;
            steps.push(call(&url,&c,&op,"sweep_merchant_treasury",json!({"merchant_id":merchant,"epoch":t["data"]["epoch"],"command":cmd(&c,&op,None).await?})).await?);
        }
        checkpoints.push(json!({"round":round,"town":view(&c,"get_town",json!({})).await?,"player":view(&c,"get_shop_inventory",json!({"shop_id":"4"})).await?,"sources":view(&c,"get_source_state",json!({})).await?}));
    }
    let after = checkpoints.last().unwrap();
    assert_eq!(
        after["town"]["data"]["totals"]["recipe_inputs_consumed"]["crystal"],
        "12"
    );
    assert_eq!(
        after["town"]["data"]["totals"]["recipe_inputs_consumed"]["herb"],
        "24"
    );
    assert_eq!(
        after["town"]["data"]["totals"]["customer_consumed"]["health_potion"],
        "8"
    );
    assert!(steps.iter().all(|s| s["succeeded"] == true));
    println!(
        "SOURCES_SANDBOX={}",
        json!({"source":"actual disposable WASM source/sink loops; accelerated time, not Testnet","steps":steps,"before":before,"checkpoints":checkpoints})
    );
    Ok(())
}
