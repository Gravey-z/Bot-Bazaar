use super::living_town_listings::capture;
use super::living_town_production::{command, reject, view};
use super::{advance_to, canonical, save_capture, wasm};
use anyhow::{Result, ensure};
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};

struct Town {
    worker: Worker<Sandbox>,
    c: Contract,
    rex: Account,
    luna: Account,
    bolt: Account,
    player: Account,
    operator: Account,
}
async fn setup(legacy: bool) -> Result<Town> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let code = if legacy {
        std::fs::read("../../data/merchant-offers-phase1/deployed-schema1.wasm")?
    } else {
        wasm()?
    };
    let c = worker.dev_deploy(&code).await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":operator.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    Ok(Town {
        worker,
        c,
        rex,
        luna,
        bolt,
        player,
        operator,
    })
}
async fn call(c: &Contract, a: &Account, m: &str, p: Value) -> Result<Value> {
    Ok(a.call(c.id(), m)
        .args_json(p)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?
        .json()?)
}
fn index(m: &str) -> usize {
    match m {
        "rex" => 0,
        "luna" => 1,
        "bolt" => 2,
        _ => panic!("merchant"),
    }
}
// Scenario calls keep participant, price, quantity and deadline terms explicit.
#[allow(clippy::too_many_arguments)]
async fn proposal(
    c: &Contract,
    b: &str,
    s: &str,
    item: &str,
    q: &str,
    price: &str,
    seq: u64,
    ttl: u64,
) -> Result<Value> {
    let t = view(c, "get_town", json!({})).await?;
    let n = &t["data"]["npc_ledgers"];
    Ok(
        json!({"buyer_merchant_id":b,"seller_merchant_id":s,"item_id":item,"quantity":q,"unit_price":price,"expires_at_ns":(t["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?+ttl*1_000_000_000).to_string(),"expected_buyer_ledger_revision":n[index(b)]["revision"],"expected_seller_ledger_revision":n[index(s)]["revision"],"command":command(c,seq).await?}),
    )
}
async fn acceptance(c: &Contract, id: &str, seq: u64) -> Result<Value> {
    let o = view(c, "get_offer", json!({"offer_id":id})).await?;
    let o = &o["data"]["offer"];
    let t = view(c, "get_town", json!({})).await?;
    let n = &t["data"]["npc_ledgers"];
    Ok(
        json!({"merchant_id":o["seller"],"offer_id":id,"expected_offer_revision":o["revision"],"expected_buyer_ledger_revision":n[index(o["buyer"].as_str().unwrap())]["revision"],"expected_seller_ledger_revision":n[index(o["seller"].as_str().unwrap())]["revision"],"command":command(c,seq).await?}),
    )
}

#[tokio::test]
async fn merchant_offers_two_controller_settlement_and_terminal_releases() -> Result<()> {
    let h = setup(false).await?;
    let c = &h.c;
    let url = h.worker.rpc_addr();
    let mut steps = vec![];
    let foundation = view(c, "get_foundation", json!({})).await?;
    ensure!(
        !foundation["data"]["supported_methods"]
            .as_array()
            .unwrap()
            .contains(&json!("merchant_purchase"))
    );
    steps.push(
        capture(
            &url,
            c,
            &h.player,
            "register_player",
            json!({"command":command(c,1).await?}),
        )
        .await?,
    );
    let p = proposal(c, "luna", "rex", "crystal", "2", "4", 1, 600).await?;
    let mut extra = p.clone();
    extra["untrusted"] = json!(true);
    reject(c, &h.luna, "propose_trade", extra, "LT:E_INVALID_ARGUMENT").await?;
    let mut invalid = p.clone();
    invalid["quantity"] = json!("3");
    reject(
        c,
        &h.luna,
        "propose_trade",
        invalid,
        "LT:E_INVALID_QUANTITY",
    )
    .await?;
    reject(
        c,
        &h.player,
        "propose_trade",
        p.clone(),
        "LT:E_UNAUTHORIZED",
    )
    .await?;
    steps.push(capture(&url, c, &h.luna, "propose_trade", p.clone()).await?);
    let before = c.view_state().await?;
    steps.push(capture(&url, c, &h.luna, "propose_trade", p).await?);
    ensure!(
        before == c.view_state().await?,
        "proposal replay changed state"
    );
    let pending = view(c, "get_town", json!({})).await?;
    ensure!(pending["data"]["npc_ledgers"][1]["gold"]["held"] == "200");
    ensure!(pending["data"]["npc_ledgers"][1]["gold"]["trade_reserved"] == "8");
    reject(
        c,
        &h.rex,
        "accept_trade",
        acceptance(c, "1", 1).await?,
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    steps.push(capture(&url,c,&h.rex,"set_listing",json!({"shop_id":"1","item_id":"crystal","quantity":"6","unit_price":"4","expected_listing_revision":"1","command":command(c,1).await?})).await?);
    let a = acceptance(c, "1", 2).await?;
    reject(c, &h.luna, "accept_trade", a.clone(), "LT:E_UNAUTHORIZED").await?;
    // Fail after staged offer/ledger/trade writes at the storage admission fence.
    // The failed receipt must roll back every collection, lane and reservation.
    let native = c.view_account().await?;
    let keep =
        u128::from(native.storage_usage) * near_sdk::env::storage_byte_cost().as_yoctonear() * 11
            / 10;
    c.as_account()
        .transfer_near(
            h.player.id(),
            near_workspaces::types::NearToken::from_yoctonear(native.balance.as_yoctonear() - keep),
        )
        .await?
        .into_result()?;
    reject(
        c,
        &h.rex,
        "accept_trade",
        a.clone(),
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    h.player
        .transfer_near(c.id(), near_workspaces::types::NearToken::from_near(2))
        .await?
        .into_result()?;
    steps.push(capture(&url, c, &h.rex, "accept_trade", a.clone()).await?);
    let before = c.view_state().await?;
    steps.push(capture(&url, c, &h.rex, "accept_trade", a).await?);
    ensure!(
        before == c.view_state().await?,
        "acceptance replay changed state"
    );
    let too_many = proposal(c, "luna", "rex", "crystal", "1", "4", 2, 600).await?;
    reject(
        c,
        &h.luna,
        "propose_trade",
        too_many,
        "LT:E_TRADE_TARGET_CAP",
    )
    .await?;
    steps.push(capture(&url,c,&h.player,"buy_from_merchant",json!({"merchant_id":"rex","item_id":"crystal","quantity":"6","expected_listing_revision":"2","max_total_price":"24","command":command(c,2).await?})).await?);
    let low = view(c, "get_town", json!({})).await?;
    steps.push(
        capture(
            &url,
            c,
            &h.rex,
            "propose_trade",
            proposal(c, "rex", "luna", "crystal", "2", "5", 3, 600).await?,
        )
        .await?,
    );
    let accept = acceptance(c, "2", 2).await?;
    let mut stale = accept.clone();
    stale["expected_buyer_ledger_revision"] = json!("999");
    reject(c, &h.luna, "accept_trade", stale, "LT:E_STALE_LEDGER").await?;
    let mut stale = accept.clone();
    stale["expected_offer_revision"] = json!("99");
    reject(c, &h.luna, "accept_trade", stale, "LT:E_STALE_OFFER").await?;
    steps.push(capture(&url, c, &h.luna, "accept_trade", accept).await?);
    reject(
        c,
        &h.luna,
        "accept_trade",
        acceptance(c, "2", 3).await?,
        "LT:E_OFFER_NOT_PENDING",
    )
    .await?;
    let after = view(c, "get_town", json!({})).await?;
    ensure!(after["data"]["npc_ledgers"][0]["gold"]["held"] == "222");
    ensure!(after["data"]["npc_ledgers"][0]["inventory"]["held"]["crystal"] == "4");
    ensure!(after["data"]["npc_ledgers"][1]["gold"]["held"] == "202");
    ensure!(after["data"]["npc_ledgers"][1]["inventory"]["held"]["crystal"] == "0");
    ensure!(after["data"]["totals"]["supplied_items"]["crystal"] == "0");
    let trade = view(c, "get_trade", json!({"trade_id":"3"})).await?;
    ensure!(
        trade["data"]["value"]["command_principal"] == "merchant:luna",
        "accepting seller must own settlement command: {trade}"
    );
    // Independent terminal paths: no transfer for rejection, cancellation or expiry.
    steps.push(
        capture(
            &url,
            c,
            &h.luna,
            "propose_trade",
            proposal(c, "luna", "rex", "crystal", "2", "4", 3, 600).await?,
        )
        .await?,
    );
    let native = c.view_account().await?;
    let keep =
        u128::from(native.storage_usage) * near_sdk::env::storage_byte_cost().as_yoctonear() * 11
            / 10;
    c.as_account()
        .transfer_near(
            h.player.id(),
            near_workspaces::types::NearToken::from_yoctonear(native.balance.as_yoctonear() - keep),
        )
        .await?
        .into_result()?;
    steps.push(capture(&url,c,&h.rex,"reject_trade",json!({"merchant_id":"rex","offer_id":"3","expected_offer_revision":"1","command":command(c,4).await?})).await?);
    h.player
        .transfer_near(c.id(), near_workspaces::types::NearToken::from_near(2))
        .await?
        .into_result()?;
    steps.push(
        capture(
            &url,
            c,
            &h.luna,
            "propose_trade",
            proposal(c, "luna", "rex", "crystal", "2", "4", 4, 600).await?,
        )
        .await?,
    );
    steps.push(capture(&url,c,&h.luna,"cancel_trade",json!({"merchant_id":"luna","offer_id":"4","expected_offer_revision":"1","command":command(c,5).await?})).await?);
    steps.push(
        capture(
            &url,
            c,
            &h.luna,
            "propose_trade",
            proposal(c, "luna", "rex", "crystal", "2", "4", 6, 90).await?,
        )
        .await?,
    );
    let o = view(c, "get_offer", json!({"offer_id":"5"})).await?;
    let deadline = o["data"]["offer"]["expires_at_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    advance_to(&h.worker, c, deadline).await?;
    let still = view(c, "get_town", json!({})).await?;
    ensure!(still["data"]["npc_ledgers"][1]["gold"]["trade_reserved"] == "8");
    reject(
        c,
        &h.rex,
        "accept_trade",
        acceptance(c, "5", 5).await?,
        "LT:E_OFFER_EXPIRED",
    )
    .await?;
    let cleanup =
        json!({"merchant_id":"luna","offer_ids":["5","4","3"],"command":command(c,7).await?});
    steps.push(capture(&url, c, &h.luna, "expire_offers", cleanup.clone()).await?);
    let before = c.view_state().await?;
    call(c, &h.luna, "expire_offers", cleanup).await?;
    ensure!(before == c.view_state().await?);
    let final_state = view(c, "get_town", json!({})).await?;
    for i in 0..3 {
        ensure!(
            final_state["data"]["npc_ledgers"][i]["gold"]
                == after["data"]["npc_ledgers"][i]["gold"]
        );
        ensure!(
            final_state["data"]["npc_ledgers"][i]["inventory"]
                == after["data"]["npc_ledgers"][i]["inventory"]
        );
    }
    save_capture(
        "living-town-merchant-offers-sandbox.json",
        &json!({"source":"isolated actual-WASM sandbox; controlled controller calls, no AI/Testnet transfers","foundation":foundation,"low":low,"after":after,"trade":trade,"steps":steps,"final":final_state}),
    )?;
    Ok(())
}

#[tokio::test]
async fn merchant_offers_competing_sellers_stock_is_not_promised_without_consent() -> Result<()> {
    let h = setup(false).await?;
    let c = &h.c;
    call(
        c,
        &h.player,
        "register_player",
        json!({"command":command(c,1).await?}),
    )
    .await?;
    call(c,&h.player,"buy_from_merchant",json!({"merchant_id":"rex","item_id":"crystal","quantity":"6","expected_listing_revision":"1","max_total_price":"24","command":command(c,2).await?})).await?;
    call(
        c,
        &h.luna,
        "propose_trade",
        proposal(c, "luna", "rex", "crystal", "2", "4", 1, 600).await?,
    )
    .await?;
    call(
        c,
        &h.bolt,
        "propose_trade",
        proposal(c, "bolt", "rex", "crystal", "2", "4", 1, 600).await?,
    )
    .await?;
    call(c,&h.rex,"set_listing",json!({"shop_id":"1","item_id":"crystal","quantity":"0","unit_price":"4","expected_listing_revision":"2","command":command(c,1).await?})).await?;
    call(c, &h.rex, "accept_trade", acceptance(c, "1", 2).await?).await?;
    reject(
        c,
        &h.rex,
        "accept_trade",
        acceptance(c, "2", 3).await?,
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    let blocked = view(c, "get_town", json!({})).await?;
    ensure!(blocked["data"]["npc_ledgers"][0]["inventory"]["held"]["crystal"] == "2");
    ensure!(blocked["data"]["npc_ledgers"][2]["gold"]["trade_reserved"] == "8");
    call(c,&h.rex,"reject_trade",json!({"merchant_id":"rex","offer_id":"2","expected_offer_revision":"1","command":command(c,3).await?})).await?;
    let after = view(c, "get_town", json!({})).await?;
    ensure!(after["data"]["npc_ledgers"][2]["gold"]["held"] == "200");
    ensure!(after["data"]["npc_ledgers"][2]["gold"]["trade_reserved"] == "0");
    save_capture(
        "living-town-merchant-offers-race.json",
        &json!({"source":"isolated actual WASM; two proposed buyers compete for one seller surplus","losing_acceptance_atomic":true,"blocked":blocked,"after":after}),
    )?;
    Ok(())
}

#[tokio::test]
async fn merchant_offers_migrate_actual_deployed_schema1_preserving_progress_and_replay()
-> Result<()> {
    let h = setup(true).await?;
    let c = &h.c;
    let registered = json!({"command":command(c,1).await?});
    call(c, &h.player, "register_player", registered).await?;
    call(
        c,
        &h.player,
        "create_shop",
        json!({"name":"Preserved shop","command":command(c,2).await?}),
    )
    .await?;
    call(c,&h.player,"buy_from_merchant",json!({"merchant_id":"rex","item_id":"crystal","quantity":"1","expected_listing_revision":"1","max_total_price":"4","command":command(c,3).await?})).await?;
    call(c,&h.player,"buy_from_merchant",json!({"merchant_id":"luna","item_id":"herb","quantity":"2","expected_listing_revision":"1","max_total_price":"6","command":command(c,4).await?})).await?;
    let started = json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"1","expected_shop_revision":"1","command":command(c,5).await?});
    call(c, &h.player, "start_production", started.clone()).await?;
    let before_town = view(c, "get_town", json!({})).await?;
    let before_player = view(c, "get_player", json!({"account_id":h.player.id()})).await?;
    let before_shop = view(c, "get_shop", json!({"shop_id":"4"})).await?;
    let principal = format!("account:{}", h.player.id());
    let before_command = view(
        c,
        "get_command",
        json!({"principal":principal,"sequence":"5"}),
    )
    .await?;
    let old_state = c.view_state().await?;
    c.as_account().deploy(&wasm()?).await?.into_result()?;
    let denied = h
        .player
        .call(c.id(), "migrate_merchant_offers")
        .args_json(json!({}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result();
    ensure!(denied.is_err());
    ensure!(old_state == c.view_state().await?);
    c.call("migrate_merchant_offers")
        .args_json(json!({}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let after_town = view(c, "get_town", json!({})).await?;
    ensure!(after_town["deployment"]["state_schema"] == "2");
    ensure!(before_town["data"] == after_town["data"]);
    ensure!(before_town["market_revision"] == after_town["market_revision"]);
    ensure!(
        before_player["data"]
            == view(c, "get_player", json!({"account_id":h.player.id()})).await?["data"]
    );
    ensure!(before_shop["data"] == view(c, "get_shop", json!({"shop_id":"4"})).await?["data"]);
    let after_command = view(
        c,
        "get_command",
        json!({"principal":principal,"sequence":"5"}),
    )
    .await?;
    ensure!(before_command["data"] == after_command["data"]);
    let state = c.view_state().await?;
    for (key, value) in &old_state {
        if key != b"STATE" {
            ensure!(
                state.get(key) == Some(value),
                "migration changed old collection bytes"
            );
        }
    }
    let replay = call(c, &h.player, "start_production", started).await?;
    ensure!(replay["data"]["replayed"] == true);
    ensure!(state == c.view_state().await?);
    let repeat = c
        .call("migrate_merchant_offers")
        .args_json(json!({}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result();
    ensure!(repeat.is_err());
    ensure!(state == c.view_state().await?);
    // New offer execution works after migration without resetting player lanes.
    call(
        c,
        &h.luna,
        "propose_trade",
        proposal(c, "luna", "rex", "crystal", "1", "4", 1, 600).await?,
    )
    .await?;
    ensure!(
        view(
            c,
            "get_command",
            json!({"principal":principal,"sequence":"5"})
        )
        .await?["data"]
            == after_command["data"]
    );
    let migrated_account = c.view_account().await?;
    save_capture(
        "living-town-merchant-offers-migration.json",
        &json!({"source":"actual pinned Testnet code downloaded read-only, initialized with synthetic local sandbox state, then upgraded locally; no Testnet migration","old_code":serde_json::from_slice::<Value>(&std::fs::read("../../data/merchant-offers-phase1/deployed-schema1.json")?)?,"before":before_town,"after":after_town,"command_before":before_command,"command_after":after_command,"storage_bytes_after_migration":migrated_account.storage_usage,"old_collection_bytes_preserved":true,"old_command_replay_unchanged":true,"private_and_repeat_migration_rejected":true}),
    )?;
    // Keep these actors exercised as independently controlled local accounts.
    ensure!(h.bolt.id() != h.operator.id());
    Ok(())
}
