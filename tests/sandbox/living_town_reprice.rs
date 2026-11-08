use super::living_town_production::{command, view};
use super::living_town_sales_races::call;
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use serde_json::{Value, json};

#[tokio::test]
async fn automatic_repricing_settles_price_only_and_revocation_rejects_old_policy() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let abi: Value = serde_json::from_slice(&std::fs::read(
        "../../target/near/living-town/bot_bazaar_living_town_abi.json",
    )?)?;
    assert_eq!(
        abi["body"]["root_schema"]["definitions"]["Decimal"]["type"],
        "string"
    );
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let w = near_workspaces::sandbox().await?;
    let c = w.dev_deploy(&wasm()?).await?;
    let op = w.dev_create_account().await?;
    let player = w.dev_create_account().await?;
    let other = w.dev_create_account().await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":op.id(),"merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let url = w.rpc_addr();
    let mut setup = vec![];
    let mut steps = vec![];
    let mut rejected = vec![];
    for (method, mut args, seq) in [
        ("register_player", json!({}), 1),
        ("create_shop", json!({"name":"Automatic shop"}), 2),
        (
            "buy_from_merchant",
            json!({"merchant_id":"luna","item_id":"herb","quantity":"4","expected_listing_revision":"1","max_total_price":"12"}),
            3,
        ),
        (
            "buy_from_merchant",
            json!({"merchant_id":"rex","item_id":"crystal","quantity":"1","expected_listing_revision":"1","max_total_price":"4"}),
            4,
        ),
        (
            "start_production",
            json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"1","expected_shop_revision":"1"}),
            5,
        ),
    ] {
        args["command"] = command(&c, seq).await?;
        let r = call(&url, &c, &player, method, args).await?;
        ensure!(r["succeeded"] == true, "{}", r["error"]);
        setup.push(r);
    }
    let ready = setup.last().unwrap()["effect"]["data"]["outcome"]["job"]["ready_at_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    super::advance_to(&w, &c, ready).await?;
    let r = call(
        &url,
        &c,
        &other,
        "complete_production",
        json!({"job_id":"1"}),
    )
    .await?;
    ensure!(r["succeeded"] == true, "{}", r["error"]);
    setup.push(r);
    let r = call(&url,&c,&player,"set_listing",json!({"shop_id":"4","item_id":"health_potion","quantity":"1","unit_price":"10","expected_listing_revision":null,"command":command(&c,6).await?})).await?;
    ensure!(r["succeeded"] == true, "{}", r["error"]);
    setup.push(r);
    let now = view(&c, "get_town", json!({})).await?["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    let policy = json!({"shop_id":"4","expected_policy_revision":"1","policy":{"mode":"auto_reprice","operator_account_id":op.id(),"allowed_items":["health_potion"],"min_price":"8","max_price":"15","expires_at_ns":(now+100_000_000_000).to_string()},"command":command(&c,7).await?});
    let r = call(&url, &c, &player, "set_assistant_permissions", policy).await?;
    ensure!(r["succeeded"] == true, "{}", r["error"]);
    setup.push(r);
    let before = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    let original = json!({"listing_id":"5","expected_listing_revision":"1","expected_policy_revision":"2","unit_price":"12","command":command(&c,1).await?});
    for patch in [
        json!({"unit_price":"7"}),
        json!({"unit_price":"16"}),
        json!({"unit_price":"10"}),
        json!({"expected_policy_revision":"1"}),
        json!({"expected_listing_revision":"2"}),
        json!({"listing_id":"1"}),
        json!({"quantity":"0"}),
        json!({"recipient":other.id()}),
    ] {
        let state = c.view_state().await?;
        let mut args = original.clone();
        for (k, v) in patch.as_object().unwrap() {
            args[k] = v.clone();
        }
        let r = call(&url, &c, &op, "assistant_reprice", args).await?;
        assert_eq!(r["succeeded"], false, "{patch}");
        assert_eq!(state, c.view_state().await?);
        rejected.push(r);
    }
    for actor in [&player, &other] {
        let mut args = original.clone();
        args["command"] = command(&c, if actor.id() == player.id() { 8 } else { 1 }).await?;
        let state = c.view_state().await?;
        let r = call(&url, &c, actor, "assistant_reprice", args).await?;
        assert_eq!(r["succeeded"], false);
        assert_eq!(state, c.view_state().await?);
        rejected.push(r);
    }
    let r = call(&url, &c, &op, "assistant_reprice", original.clone()).await?;
    ensure!(r["succeeded"] == true, "{}", r["error"]);
    steps.push(r);
    assert_eq!(
        steps[0]["effect"]["data"]["outcome"]["listing"]["remaining_quantity"],
        "1"
    );
    assert_eq!(
        before["data"],
        view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?["data"]
    );
    // Expired policy rejects a new sequence; the original exact acknowledgment remains replayable.
    super::advance_to(&w, &c, now + 100_000_000_000).await?;
    let mut expired = original.clone();
    expired["command"] = command(&c, 2).await?;
    expired["unit_price"] = json!("13");
    expired["expected_listing_revision"] = json!("2");
    let state = c.view_state().await?;
    let r = call(&url, &c, &op, "assistant_reprice", expired.clone()).await?;
    assert_eq!(r["succeeded"], false);
    assert_eq!(state, c.view_state().await?);
    rejected.push(r);
    let off = json!({"shop_id":"4","expected_policy_revision":"2","policy":{"mode":"off","operator_account_id":null,"allowed_items":[],"min_price":"1","max_price":"1","expires_at_ns":null},"command":command(&c,8).await?});
    let r = call(&url, &c, &player, "set_assistant_permissions", off).await?;
    ensure!(r["succeeded"] == true, "{}", r["error"]);
    setup.push(r);
    expired["command"] = command(&c, 2).await?;
    let state = c.view_state().await?;
    let r = call(&url, &c, &op, "assistant_reprice", expired).await?;
    assert_eq!(r["succeeded"], false);
    assert_eq!(state, c.view_state().await?);
    rejected.push(r);
    let state = c.view_state().await?;
    let replay = call(&url, &c, &op, "assistant_reprice", original).await?;
    ensure!(replay["succeeded"] == true, "{}", replay["error"]);
    assert_eq!(replay["effect"]["data"]["replayed"], true);
    assert_eq!(state, c.view_state().await?);
    steps.push(replay);
    let after = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    assert_eq!(before["data"], after["data"]);
    let fixture = json!({"source":"actual local disposable WASM, no Testnet deployment or inference","setup":setup,"steps":steps,"rejected":rejected,"before":before,"after":after});
    super::save_capture("living-town-reprice-sandbox.json", &fixture)?;
    println!(
        "automatic repricing: {} successes, {} rejected calls",
        fixture["steps"].as_array().unwrap().len(),
        fixture["rejected"].as_array().unwrap().len()
    );
    Ok(())
}
