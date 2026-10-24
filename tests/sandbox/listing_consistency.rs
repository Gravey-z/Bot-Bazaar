use super::wasm;
use anyhow::Result;
use serde_json::{Value, json};
use std::path::Path;

#[tokio::test]
async fn concurrent_buyers_with_the_same_quote_cannot_oversell() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let rex = worker.dev_create_account().await?;
    let first = worker.dev_create_account().await?;
    let second = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":"luna.testnet","bolt":"bolt.testnet"}
    })).transact().await?.into_result()?;
    for buyer in [&first, &second] {
        buyer
            .call(contract.id(), "register_player")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()?;
    }
    let seed: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    let buyers = [&first, &second];
    let quote = json!({"merchant_id":"rex","resource":"crystal","quantity":"12","max_total_price":"48","listing_version":"1"});
    let (a, b) = tokio::join!(
        first
            .call(contract.id(), "buy_from_merchant")
            .args_json(quote.clone())
            .transact(),
        second
            .call(contract.id(), "buy_from_merchant")
            .args_json(quote.clone())
            .transact(),
    );
    let results = [a?.into_result(), b?.into_result()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let winner = results.iter().position(|result| result.is_ok()).unwrap();
    let loser = 1 - winner;
    let success: Value = results[winner].as_ref().unwrap().json()?;
    assert_eq!(
        success["data"]["buyer"]["account_id"],
        buyers[winner].id().as_str()
    );
    assert!(
        results[loser]
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("BB:E_STALE_LISTING")
    );
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(market["market_revision"], "4");
    assert_eq!(market["data"]["next_trade_id"], "2");
    assert_eq!(market["data"]["merchants"][0]["gold"], "228");
    assert_eq!(market["data"]["merchants"][0]["inventory"]["crystal"], "3");
    assert_eq!(
        market["data"]["merchants"][0]["listings"][0]["quantity"],
        "3"
    );
    assert_eq!(
        market["data"]["merchants"][0]["listings"][0]["version"],
        "2"
    );
    for (index, buyer) in buyers.iter().enumerate() {
        let state: Value = contract
            .view("get_player")
            .args_json(json!({"account_id":buyer.id()}))
            .await?
            .json()?;
        assert_eq!(
            state["data"]["gold"],
            if index == winner { "52" } else { "100" }
        );
        assert_eq!(
            state["data"]["inventory"]["crystal"],
            if index == winner { "12" } else { "0" }
        );
    }
    let before = contract.view_state().await?;
    let replay = buyers[loser]
        .call(contract.id(), "buy_from_merchant")
        .args_json(quote)
        .transact()
        .await?;
    assert!(
        replay
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_STALE_LISTING")
    );
    assert_eq!(contract.view_state().await?, before);
    let before_second: [Value; 2] = [
        contract
            .view("get_player")
            .args_json(json!({"account_id":first.id()}))
            .await?
            .json()?,
        contract
            .view("get_player")
            .args_json(json!({"account_id":second.id()}))
            .await?
            .json()?,
    ];
    let quote = json!({"merchant_id":"rex","resource":"crystal","quantity":"3","max_total_price":"12","listing_version":"2"});
    let (a, b) = tokio::join!(
        first
            .call(contract.id(), "buy_from_merchant")
            .args_json(quote.clone())
            .transact(),
        second
            .call(contract.id(), "buy_from_merchant")
            .args_json(quote)
            .transact(),
    );
    let results = [a?.into_result(), b?.into_result()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let winner = results.iter().position(|result| result.is_ok()).unwrap();
    assert!(
        results[1 - winner]
            .as_ref()
            .unwrap_err()
            .to_string()
            .contains("BB:E_STALE_LISTING")
    );
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(market["market_revision"], "5");
    assert_eq!(market["data"]["next_trade_id"], "3");
    let merchant = &market["data"]["merchants"][0];
    assert_eq!(merchant["gold"], "240");
    assert_eq!(merchant["inventory"]["crystal"], "0");
    assert_eq!(merchant["listings"][0]["quantity"], "0");
    assert_eq!(merchant["listings"][0]["active"], false);
    assert_eq!(merchant["listings"][0]["version"], "3");
    assert_eq!(merchant["last_action_id"], "0");
    for index in 1..4 {
        assert_eq!(
            merchant["listings"][index],
            seed["data"]["merchants"][0]["listings"][index]
        );
    }
    for index in 1..3 {
        assert_eq!(
            market["data"]["merchants"][index],
            seed["data"]["merchants"][index]
        );
    }
    let mut player_gold = 0_u64;
    let mut player_crystals = 0_u64;
    for (index, buyer) in buyers.iter().enumerate() {
        let state: Value = contract
            .view("get_player")
            .args_json(json!({"account_id":buyer.id()}))
            .await?
            .json()?;
        let old_gold = before_second[index]["data"]["gold"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        let old_crystals = before_second[index]["data"]["inventory"]["crystal"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        let gold = state["data"]["gold"].as_str().unwrap().parse::<u64>()?;
        let crystals = state["data"]["inventory"]["crystal"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        assert_eq!(gold, old_gold - if index == winner { 12 } else { 0 });
        assert_eq!(crystals, old_crystals + if index == winner { 3 } else { 0 });
        player_gold += gold;
        player_crystals += crystals;
    }
    assert_eq!(player_gold + 240 + 220 + 150, 750);
    assert_eq!(player_crystals + 12 + 2, 29);
    let history: Value = contract
        .view("get_recent_trades")
        .args_json(json!({"after_id":null,"limit":"50","expected_revision":"5"}))
        .await?
        .json()?;
    assert_eq!(history["data"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        history["data"]["items"][1]["buyer"]["account_id"],
        buyers[winner].id().as_str()
    );
    let before = contract.view_state().await?;
    let stale = rex
        .call(contract.id(), "set_listing")
        .args_json(json!({
            "merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"0",
            "active":false,"expected_version":"1","action_id":"1"
        }))
        .transact()
        .await?;
    assert!(
        stale
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_STALE_LISTING")
    );
    assert_eq!(contract.view_state().await?, before);
    let changed: Value = rex
        .call(contract.id(), "set_listing")
        .args_json(json!({
            "merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"0",
            "active":false,"expected_version":"3","action_id":"1"
        }))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(changed["data"]["listing"]["version"], "4");
    assert_eq!(changed["data"]["action"]["action_id"], "1");
    println!("LISTING_RACES rounds=2 successful_purchases=2 stale_rejections=2 stock_sold=15");
    Ok(())
}

#[tokio::test]
async fn stock_changes_clamp_and_restocking_requires_explicit_listing_activation() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let production = wasm()?;
    let contract = worker.dev_deploy(&production).await?;
    let rex = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":"luna.testnet","bolt":"bolt.testnet"}
    })).transact().await?.into_result()?;
    player
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    rex.call(contract.id(), "set_listing")
        .args_json(json!({
            "merchant_id":"rex","resource":"crystal","unit_price":"4","quantity":"2",
            "active":true,"expected_version":"1","action_id":"1"
        }))
        .transact()
        .await?
        .into_result()?;
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    for (step, (stock, quantity, active, version, revision)) in [
        (10, "2", true, "3", "4"),
        (0, "0", false, "5", "6"),
        (7, "0", false, "6", "7"),
        (9, "0", false, "7", "8"),
        (9, "0", false, "7", "8"),
    ]
    .into_iter()
    .enumerate()
    {
        let before = contract.view_state().await?;
        contract
            .as_account()
            .batch(contract.id())
            .deploy(&fixture)
            .transact()
            .await?
            .into_result()?;
        contract
            .call("shift_stock")
            .args_json(json!({"merchant_id":"rex","resource":"crystal","new_stock":stock}))
            .transact()
            .await?
            .into_result()?;
        contract
            .as_account()
            .batch(contract.id())
            .deploy(&production)
            .transact()
            .await?
            .into_result()?;
        let market: Value = contract
            .view("get_market_state")
            .args_json(json!({}))
            .await?
            .json()?;
        assert_eq!(market["market_revision"], revision);
        assert_eq!(
            market["data"]["merchants"][0]["inventory"]["crystal"],
            stock.to_string()
        );
        let listing = &market["data"]["merchants"][0]["listings"][0];
        assert_eq!(listing["quantity"], quantity);
        assert_eq!(listing["active"], active);
        assert_eq!(listing["unit_price"], "4");
        assert_eq!(listing["version"], version);
        for index in 1..4 {
            assert_eq!(
                market["data"]["merchants"][0]["listings"][index]["version"],
                "1"
            );
        }
        if step == 4 {
            assert_eq!(contract.view_state().await?, before);
        }
        if stock == 10 {
            let before = contract.view_state().await?;
            let stale=player.call(contract.id(),"buy_from_merchant").args_json(json!({
                "merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"4","listing_version":"2"
            })).transact().await?;
            assert!(
                stale
                    .into_result()
                    .unwrap_err()
                    .to_string()
                    .contains("BB:E_STALE_LISTING")
            );
            assert_eq!(contract.view_state().await?, before);
            player.call(contract.id(),"buy_from_merchant").args_json(json!({
                "merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"4","listing_version":"3"
            })).transact().await?.into_result()?;
            let updated: Value = contract
                .view("get_merchant")
                .args_json(json!({"merchant_id":"rex"}))
                .await?
                .json()?;
            assert_eq!(updated["data"]["inventory"]["crystal"], "9");
            assert_eq!(updated["data"]["listings"][0]["quantity"], "1");
            assert_eq!(updated["data"]["listings"][0]["version"], "4");
        } else {
            let before = contract.view_state().await?;
            let inactive=player.call(contract.id(),"buy_from_merchant").args_json(json!({
                "merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"4","listing_version":version
            })).transact().await?;
            assert!(
                inactive
                    .into_result()
                    .unwrap_err()
                    .to_string()
                    .contains("BB:E_LISTING_INACTIVE")
            );
            assert_eq!(contract.view_state().await?, before);
        }
    }
    let activated: Value = rex
        .call(contract.id(), "set_listing")
        .args_json(json!({
            "merchant_id":"rex","resource":"crystal","unit_price":"4","quantity":"2",
            "active":true,"expected_version":"7","action_id":"2"
        }))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(activated["data"]["listing"]["version"], "8");
    player.call(contract.id(),"buy_from_merchant").args_json(json!({
        "merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"4","listing_version":"8"
    })).transact().await?.into_result()?;
    let merchant: Value = contract
        .view("get_merchant")
        .args_json(json!({"merchant_id":"rex"}))
        .await?
        .json()?;
    assert_eq!(merchant["data"]["inventory"]["crystal"], "8");
    assert_eq!(merchant["data"]["listings"][0]["quantity"], "1");
    assert_eq!(merchant["data"]["listings"][0]["version"], "9");
    assert_eq!(merchant["data"]["last_action_id"], "2");
    let before = contract.view_state().await?;
    assert!(
        contract
            .call("shift_stock")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    Ok(())
}
