use super::living_town_listings::capture;
use super::living_town_production::{command, reject, view};
use super::{canonical, save_capture, wasm};
use anyhow::{Result, ensure};
use serde_json::{Value, json};

#[tokio::test]
async fn peer_backups_replenish_a_depleted_supplier_without_creating_assets() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    let initial = view(&c, "get_town", json!({})).await?;
    let url = worker.rpc_addr();
    let mut steps = Vec::new();
    let backup = json!({"buyer_merchant_id":"luna","merchant_id":"rex","item_id":"crystal","quantity":"2","expected_listing_revision":"1","max_total_price":"8","command":command(&c,1).await?});
    steps.push(capture(&url, &c, &luna, "merchant_purchase", backup.clone()).await?);
    let before = c.view_state().await?;
    steps.push(capture(&url, &c, &luna, "merchant_purchase", backup).await?);
    ensure!(before == c.view_state().await?, "replay changed state");
    steps.push(
        capture(
            &url,
            &c,
            &player,
            "register_player",
            json!({"command":command(&c,1).await?}),
        )
        .await?,
    );
    steps.push(capture(&url,&c,&player,"buy_from_merchant",json!({"merchant_id":"rex","item_id":"crystal","quantity":"6","expected_listing_revision":"2","max_total_price":"24","command":command(&c,2).await?})).await?);
    let low = view(&c, "get_town", json!({})).await?;
    ensure!(low["data"]["npc_ledgers"][0]["inventory"]["held"]["crystal"] == "2");
    ensure!(low["data"]["npc_ledgers"][1]["inventory"]["held"]["crystal"] == "2");
    steps.push(capture(&url,&c,&luna,"set_listing",json!({"shop_id":"2","item_id":"crystal","quantity":"2","unit_price":"5","expected_listing_revision":null,"command":command(&c,2).await?})).await?);
    let buyback = json!({"buyer_merchant_id":"rex","merchant_id":"luna","item_id":"crystal","quantity":"2","expected_listing_revision":"1","max_total_price":"10","command":command(&c,1).await?});
    reject(
        &c,
        &player,
        "merchant_purchase",
        buyback.clone(),
        "LT:E_UNAUTHORIZED",
    )
    .await?;
    let mut stale = buyback.clone();
    stale["expected_listing_revision"] = json!("2");
    reject(&c, &rex, "merchant_purchase", stale, "LT:E_STALE_LISTING").await?;
    steps.push(capture(&url, &c, &rex, "merchant_purchase", buyback).await?);
    steps.push(capture(&url,&c,&rex,"set_listing",json!({"shop_id":"1","item_id":"crystal","quantity":"2","unit_price":"6","expected_listing_revision":"3","command":command(&c,2).await?})).await?);
    let after = view(&c, "get_town", json!({})).await?;
    ensure!(after["data"]["npc_ledgers"][0]["inventory"]["held"]["crystal"] == "4");
    ensure!(after["data"]["npc_ledgers"][1]["inventory"]["held"]["crystal"] == "0");
    ensure!(after["data"]["npc_ledgers"][1]["gold"]["held"] == "202");
    ensure!(after["data"]["totals"]["supplied_items"]["crystal"] == "0");
    save_capture(
        "living-town-merchant-trading-sandbox.json",
        &json!({"source":"disposable WASM sandbox; declared synthetic genesis; no Testnet actions","contract_id":c.id(),"initial":initial,"low":low,"after":after,"steps":steps}),
    )?;
    Ok(())
}
