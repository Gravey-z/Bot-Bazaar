use super::living_town_adapter::rpc;
use super::living_town_production::{command, pinned, view};
use super::living_town_sales_races::call;
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

async fn act(
    url: &str,
    c: &Contract,
    a: &Account,
    seq: &mut u64,
    method: &str,
    mut args: Value,
    trace: &mut Vec<Value>,
) -> Result<Value> {
    for _ in 0..4 {
        args["command"] = command(c, *seq).await?;
        if ["fund_customer_budget", "settle_customer_purchase"].contains(&method) {
            args["epoch"] = view(c, "get_town", json!({})).await?["data"]["epoch"].clone();
        }
        let r = call(url, c, a, method, args.clone()).await?;
        trace.push(r.clone());
        if r["succeeded"] == true {
            *seq += 1;
            return Ok(r);
        }
        ensure!(
            r["error"]
                .as_str()
                .unwrap_or("")
                .contains("LT:E_EPOCH_MISMATCH"),
            "{}: {}",
            method,
            r["error"]
        );
    }
    anyhow::bail!("epoch changed during four bounded fixture retries")
}
async fn revision(c: &Contract) -> Result<Value> {
    Ok(view(c, "get_shop", json!({"shop_id":"4"})).await?["data"]["revision"].clone())
}
async fn rejected(
    url: &str,
    c: &Contract,
    a: &Account,
    args: Value,
    rows: &mut Vec<Value>,
) -> Result<()> {
    let before = c.view_state().await?;
    let r = call(url, c, a, "purchase_upgrade", args).await?;
    ensure!(r["succeeded"] == false, "upgrade should reject");
    assert_eq!(before, c.view_state().await?);
    rows.push(r);
    Ok(())
}
#[tokio::test]
async fn earned_second_slot_burns_once_and_two_jobs_complete_independently() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let w = near_workspaces::sandbox().await?;
    let c = w.dev_deploy(&wasm()?).await?;
    let owner = w.dev_create_account().await?;
    let op = w.dev_create_account().await?;
    let other = w.dev_create_account().await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":op.id(),"merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    let mut trace = vec![];
    let mut failures = vec![];
    let mut seq = 1;
    let mut os = 1;
    act(
        &w.rpc_addr(),
        &c,
        &owner,
        &mut seq,
        "register_player",
        json!({}),
        &mut trace,
    )
    .await?;
    act(
        &w.rpc_addr(),
        &c,
        &owner,
        &mut seq,
        "create_shop",
        json!({"name":"Earned upgrade"}),
        &mut trace,
    )
    .await?;
    rejected(&w.rpc_addr(),&c,&owner,json!({"shop_id":"4","upgrade_id":"second_slot","expected_shop_revision":"1","command":command(&c,seq).await?}),&mut failures).await?;
    for (recipe, inputs, price) in [
        (
            "health_potion",
            vec![("luna", "herb", "6"), ("rex", "crystal", "3")],
            "18",
        ),
        (
            "iron_tool",
            vec![("bolt", "iron", "6"), ("bolt", "wood", "3")],
            "24",
        ),
        (
            "health_potion",
            vec![("luna", "herb", "6"), ("rex", "crystal", "3")],
            "18",
        ),
    ] {
        for (merchant, item, q) in inputs {
            let rows=view(&c,"get_listings",json!({"shop_id":null,"item_id":item,"active_only":true,"after_id":null,"limit":"50","expected_market_revision":view(&c,"get_town",json!({})).await?["market_revision"]})).await?;
            let l = &rows["data"]["items"][0];
            act(&w.rpc_addr(),&c,&owner,&mut seq,"buy_from_merchant",json!({"merchant_id":merchant,"item_id":item,"quantity":q,"expected_listing_revision":l["revision"],"max_total_price":"100"}),&mut trace).await?;
        }
        let started=act(&w.rpc_addr(),&c,&owner,&mut seq,"start_production",json!({"shop_id":"4","recipe_id":recipe,"recipe_version":"1","quantity":"3","expected_shop_revision":revision(&c).await?}),&mut trace).await?;
        w.fast_forward(2000).await?;
        let completed = call(
            &w.rpc_addr(),
            &c,
            &other,
            "complete_production",
            json!({"job_id":started["effect"]["data"]["outcome"]["job"]["job_id"]}),
        )
        .await?;
        ensure!(completed["succeeded"] == true, "{}", completed["error"]);
        trace.push(completed);
        let listed=act(&w.rpc_addr(),&c,&owner,&mut seq,"set_listing",json!({"shop_id":"4","item_id":recipe,"quantity":"3","unit_price":price,"expected_listing_revision":if recipe=="health_potion"&&trace.iter().any(|r|r["method"]=="set_listing"&&r["args"]["item_id"]=="health_potion"){json!("4")}else{Value::Null}}),&mut trace).await?;
        let listing = listed["effect"]["data"]["outcome"]["listing"]["listing_id"].clone();
        for n in 0..3 {
            w.fast_forward(200).await?;
            let t = view(&c, "get_town", json!({})).await?;
            let epoch = t["data"]["epoch"].clone();
            act(
                &w.rpc_addr(),
                &c,
                &op,
                &mut os,
                "fund_customer_budget",
                json!({"epoch":epoch}),
                &mut trace,
            )
            .await?;
            let rev = listed["effect"]["data"]["outcome"]["listing"]["revision"]
                .as_str()
                .unwrap()
                .parse::<u64>()?
                + n;
            act(&w.rpc_addr(),&c,&op,&mut os,"settle_customer_purchase",json!({"listing_id":listing,"expected_listing_revision":rev.to_string(),"epoch":epoch,"max_total_price":price}),&mut trace).await?;
        }
    }
    let eligible = view(&c, "get_upgrade", json!({"shop_id":"4"})).await?;
    assert_eq!(eligible["data"]["eligible"], true);
    let args = json!({"shop_id":"4","upgrade_id":"second_slot","expected_shop_revision":revision(&c).await?,"command":command(&c,seq).await?});
    rejected(&w.rpc_addr(), &c, &other, args.clone(), &mut failures).await?;
    let mut invalid = args.clone();
    invalid["expected_shop_revision"] = json!("1");
    rejected(&w.rpc_addr(), &c, &owner, invalid, &mut failures).await?;
    let mut invalid = args.clone();
    invalid["upgrade_id"] = json!("third_slot");
    rejected(&w.rpc_addr(), &c, &owner, invalid, &mut failures).await?;
    let before = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    let upgrade=act(&w.rpc_addr(),&c,&owner,&mut seq,"purchase_upgrade",json!({"shop_id":"4","upgrade_id":"second_slot","expected_shop_revision":revision(&c).await?}),&mut trace).await?;
    let storage = c.view_state().await?;
    let replay = call(
        &w.rpc_addr(),
        &c,
        &owner,
        "purchase_upgrade",
        upgrade["args"].clone(),
    )
    .await?;
    assert_eq!(replay["effect"]["data"]["replayed"], true);
    assert_eq!(storage, c.view_state().await?);
    trace.push(replay);
    rejected(&w.rpc_addr(),&c,&owner,json!({"shop_id":"4","upgrade_id":"second_slot","expected_shop_revision":revision(&c).await?,"command":command(&c,seq).await?}),&mut failures).await?;
    let after = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    assert_eq!(before["data"]["gold"]["held"], "184");
    assert_eq!(after["data"]["gold"]["held"], "34");
    assert_eq!(
        view(&c, "get_town", json!({})).await?["data"]["totals"]["upgrade_burns"],
        "150"
    );
    for (item, q) in [("iron", "4"), ("wood", "2")] {
        let t = view(&c, "get_town", json!({})).await?;
        let rows=view(&c,"get_listings",json!({"shop_id":"3","item_id":item,"active_only":true,"after_id":null,"limit":"50","expected_market_revision":t["market_revision"]})).await?;
        act(&w.rpc_addr(),&c,&owner,&mut seq,"buy_from_merchant",json!({"merchant_id":"bolt","item_id":item,"quantity":q,"expected_listing_revision":rows["data"]["items"][0]["revision"],"max_total_price":"100"}),&mut trace).await?;
    }
    let mut jobs = vec![];
    for _ in 0..2 {
        let r=act(&w.rpc_addr(),&c,&owner,&mut seq,"start_production",json!({"shop_id":"4","recipe_id":"iron_tool","recipe_version":"1","quantity":"1","expected_shop_revision":revision(&c).await?}),&mut trace).await?;
        jobs.push(r["effect"]["data"]["outcome"]["job"].clone());
    }
    let running=view(&c,"get_production_jobs",json!({"shop_id":"4","status":"running","after_id":null,"limit":"50","expected_market_revision":view(&c,"get_town",json!({})).await?["market_revision"]})).await?;
    assert_eq!(running["data"]["items"].as_array().unwrap().len(), 2);
    let storage = c.view_state().await?;
    let third=call(&w.rpc_addr(),&c,&owner,"start_production",json!({"shop_id":"4","recipe_id":"iron_tool","recipe_version":"1","quantity":"1","expected_shop_revision":revision(&c).await?,"command":command(&c,seq).await?})).await?;
    assert_eq!(third["succeeded"], false);
    assert_eq!(storage, c.view_state().await?);
    failures.push(third);
    w.fast_forward(1000).await?;
    for job in jobs.iter().rev() {
        let r = call(
            &w.rpc_addr(),
            &c,
            &other,
            "complete_production",
            json!({"job_id":job["job_id"]}),
        )
        .await?;
        ensure!(r["succeeded"] == true, "{}", r["error"]);
        trace.push(r);
    }
    let block = rpc(&w.rpc_addr(), "block", json!({"finality":"final"}))?;
    let town = pinned(&w.rpc_addr(), &c, &block, "get_town", json!({}))?;
    let shop = pinned(
        &w.rpc_addr(),
        &c,
        &block,
        "get_shop",
        json!({"shop_id":"4"}),
    )?;
    let ledger = pinned(
        &w.rpc_addr(),
        &c,
        &block,
        "get_shop_inventory",
        json!({"shop_id":"4"}),
    )?;
    let mut production = vec![];
    for id in ["1", "2", "3", "4"] {
        production.push(json!({"shopId":id,"pages":[pinned(&w.rpc_addr(),&c,&block,"get_production_jobs",json!({"shop_id":id,"status":"all","after_id":null,"limit":"50","expected_market_revision":town["market_revision"]}))?]}));
    }
    let listings = pinned(
        &w.rpc_addr(),
        &c,
        &block,
        "get_listings",
        json!({"shop_id":null,"item_id":null,"active_only":false,"after_id":null,"limit":"50","expected_market_revision":town["market_revision"]}),
    )?;
    let baseline = json!({"block":block,"town":town,"shops":[{"shop":shop,"ledger":ledger}],"production":production,"listings":[listings]});
    let fixture = json!({"source":"actual local disposable WASM; no live deployment or inference","eligible":eligible,"upgrade_before":before,"upgrade_after":after,"running":running,"baseline":baseline,"steps":trace,"rejected":failures});
    std::fs::write(
        "../fixtures/chain/living-town-upgrade-sandbox.json",
        serde_json::to_string_pretty(&fixture)? + "\n",
    )?;
    Ok(())
}
