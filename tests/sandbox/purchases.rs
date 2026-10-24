use super::wasm;
use anyhow::Result;
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use std::path::Path;

fn args() -> Value {
    json!({"merchant_id":"rex","resource":"crystal","quantity":"12","max_total_price":"48","listing_version":"1"})
}

#[tokio::test]
async fn public_purchases_settle_atomically_and_preserve_assets_on_rejection() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    assert!(
        player
            .call(contract.id(), "buy_from_merchant")
            .args_json(args())
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert!(contract.view_state().await?.is_empty());
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}
    })).transact().await?.into_result()?;
    let seed: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    player
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let before = contract.view_state().await?;
    for caller in [&attacker, &owner, &rex, contract.as_account()] {
        let result = caller
            .call(contract.id(), "buy_from_merchant")
            .args_json(args())
            .transact()
            .await?;
        assert!(
            result
                .into_result()
                .unwrap_err()
                .to_string()
                .contains("BB:E_NOT_REGISTERED")
        );
        assert_eq!(contract.view_state().await?, before);
    }
    for (field, value, code) in [
        ("quantity", "0", "BB:E_INVALID_QUANTITY"),
        ("quantity", "101", "BB:E_INVALID_QUANTITY"),
        ("quantity", "16", "BB:E_INSUFFICIENT_LISTED_QUANTITY"),
        ("quantity", "18446744073709551615", "BB:E_INVALID_QUANTITY"),
        ("max_total_price", "0", "BB:E_INVALID_TOTAL"),
        ("max_total_price", "10001", "BB:E_INVALID_TOTAL"),
        ("max_total_price", "47", "BB:E_INVALID_TOTAL"),
        ("listing_version", "0", "BB:E_STALE_LISTING"),
    ] {
        let mut input = args();
        input[field] = json!(value);
        let result = player
            .call(contract.id(), "buy_from_merchant")
            .args_json(input)
            .transact()
            .await?;
        assert!(result.into_result().unwrap_err().to_string().contains(code));
        assert_eq!(contract.view_state().await?, before);
    }
    let mut inactive = args();
    inactive["resource"] = json!("herb");
    inactive["quantity"] = json!("1");
    let result = player
        .call(contract.id(), "buy_from_merchant")
        .args_json(inactive)
        .transact()
        .await?;
    assert!(
        result
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_LISTING_INACTIVE")
    );
    assert_eq!(contract.view_state().await?, before);
    for field in [
        "merchant_id",
        "resource",
        "quantity",
        "max_total_price",
        "listing_version",
    ] {
        let mut invalid = args();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            player
                .call(contract.id(), "buy_from_merchant")
                .args_json(invalid)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    let mut malformed = vec![json!([]), json!(null)];
    for (field, value) in [
        ("account_id", json!(attacker.id())),
        ("merchant_id", json!("other")),
        ("resource", json!("gold")),
        ("merchant_id", json!({"rex":null})),
        ("quantity", json!(12)),
        ("quantity", json!("01")),
        ("quantity", json!("-1")),
        ("quantity", json!("+1")),
        ("quantity", json!("1.5")),
        ("quantity", json!(" 1")),
        ("listing_version", json!("18446744073709551616")),
        ("max_total_price", json!(null)),
        ("max_total_price", json!(false)),
    ] {
        let mut input = args();
        input[field] = value;
        malformed.push(input);
    }
    for invalid in malformed {
        assert!(
            player
                .call(contract.id(), "buy_from_merchant")
                .args_json(invalid)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    let duplicate=br#"{"merchant_id":"rex","resource":"crystal","quantity":"12","quantity":"1","max_total_price":"48","listing_version":"1"}"#.to_vec();
    assert!(
        player
            .call(contract.id(), "buy_from_merchant")
            .args(duplicate)
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    assert!(
        player
            .call(contract.id(), "buy_from_merchant")
            .args_json(args())
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    let success = player
        .call(contract.id(), "buy_from_merchant")
        .args_json(args())
        .transact()
        .await?
        .into_result()?;
    let gas = success.total_gas_burnt.as_gas();
    let result: Value = success.json()?;
    let trade = &result["data"];
    assert_eq!(result["market_revision"], "3");
    assert_eq!(trade["trade_id"], "1");
    assert_eq!(trade["kind"], "player_purchase");
    assert_eq!(
        trade["buyer"],
        json!({"kind":"player","account_id":player.id()})
    );
    assert_eq!(
        trade["seller"],
        json!({"kind":"merchant","merchant_id":"rex"})
    );
    assert_eq!(trade["resource"], "crystal");
    assert_eq!(trade["quantity"], "12");
    assert_eq!(trade["unit_price"], "4");
    assert_eq!(trade["total_price"], "48");
    assert_eq!(trade["buyer_gold_after"], "52");
    assert_eq!(trade["seller_gold_after"], "228");
    assert_eq!(trade["buyer_resource_after"], "12");
    assert_eq!(trade["seller_resource_after"], "3");
    assert_eq!(trade["offer_id"], Value::Null);
    assert_eq!(trade["market_revision"], "3");
    assert_eq!(trade["settled_at_ns"], result["block_timestamp_ns"]);
    let history: Value = contract
        .view("get_recent_trades")
        .args_json(json!({"after_id":null,"limit":"50","expected_revision":"3"}))
        .await?
        .json()?;
    assert_eq!(history["data"]["items"], json!([trade]));
    let current: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(
        current["data"]["merchants"][0]["listings"][0]["quantity"],
        "3"
    );
    assert_eq!(
        current["data"]["merchants"][0]["listings"][0]["version"],
        "2"
    );
    assert_eq!(current["data"]["merchants"][0]["last_action_id"], "0");
    let before = contract.view_state().await?;
    let retry = player
        .call(contract.id(), "buy_from_merchant")
        .args_json(args())
        .transact()
        .await?;
    assert!(
        retry
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_STALE_LISTING")
    );
    assert_eq!(contract.view_state().await?, before);
    owner
        .call(contract.id(), "pause_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let paused = contract.view_state().await?;
    let mut remainder = args();
    remainder["quantity"] = json!("3");
    remainder["listing_version"] = json!("2");
    let rejected = player
        .call(contract.id(), "buy_from_merchant")
        .args_json(remainder.clone())
        .transact()
        .await?;
    assert!(
        rejected
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_MARKET_PAUSED")
    );
    assert_eq!(contract.view_state().await?, paused);
    owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    for (price, version, action) in [("100", "2", "1"), ("4", "3", "2")] {
        rex.call(contract.id(), "set_listing")
            .args_json(json!({
                "merchant_id":"rex","resource":"crystal","unit_price":price,"quantity":"3",
                "active":true,"expected_version":version,"action_id":action
            }))
            .transact()
            .await?
            .into_result()?;
        if price == "100" {
            let before = contract.view_state().await?;
            let input = json!({"merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"100","listing_version":"3"});
            let result = player
                .call(contract.id(), "buy_from_merchant")
                .args_json(input)
                .transact()
                .await?;
            assert!(
                result
                    .into_result()
                    .unwrap_err()
                    .to_string()
                    .contains("BB:E_INSUFFICIENT_GOLD")
            );
            assert_eq!(contract.view_state().await?, before);
        }
    }
    remainder["listing_version"] = json!("4");
    remainder["max_total_price"] = json!("12");
    player
        .call(contract.id(), "buy_from_merchant")
        .args_json(remainder)
        .transact()
        .await?
        .into_result()?;
    let empty: Value = contract
        .view("get_merchant")
        .args_json(json!({"merchant_id":"rex"}))
        .await?
        .json()?;
    assert_eq!(empty["data"]["listings"][0]["quantity"], "0");
    assert_eq!(empty["data"]["listings"][0]["active"], false);
    assert_eq!(empty["data"]["listings"][0]["version"], "5");
    assert_eq!(empty["data"]["last_action_id"], "2");
    let action_before = empty["data"]["last_action"].clone();
    let before = contract.view_state().await?;
    let input = json!({"merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"4","listing_version":"5"});
    let result = player
        .call(contract.id(), "buy_from_merchant")
        .args_json(input)
        .transact()
        .await?;
    assert!(
        result
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_LISTING_INACTIVE")
    );
    assert_eq!(contract.view_state().await?, before);
    for (merchant, resource, quantity, total) in
        [("bolt", "wood", "2", "4"), ("luna", "herb", "1", "3")]
    {
        player.call(contract.id(),"buy_from_merchant").args_json(json!({
            "merchant_id":merchant,"resource":resource,"quantity":quantity,"max_total_price":total,"listing_version":"1"
        })).transact().await?.into_result()?;
    }
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    let player_state: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":player.id()}))
        .await?
        .json()?;
    assert_eq!(market["market_revision"], "10");
    assert_eq!(market["data"]["next_trade_id"], "5");
    assert_eq!(market["data"]["next_offer_id"], "1");
    assert_eq!(market["data"]["total_issued_gold"], "650");
    assert_eq!(
        market["data"]["resource_supply"],
        seed["data"]["resource_supply"]
    );
    assert_eq!(market["data"]["merchants"][0]["last_action"], action_before);
    let merchants = market["data"]["merchants"].as_array().unwrap();
    let gold = player_state["data"]["gold"]
        .as_str()
        .unwrap()
        .parse::<u64>()?
        + merchants
            .iter()
            .map(|m| m["gold"].as_str().unwrap().parse::<u64>().unwrap())
            .sum::<u64>();
    assert_eq!(gold, 650);
    for resource in ["crystal", "wood", "herb", "iron"] {
        let total = player_state["data"]["inventory"][resource]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + merchants
                .iter()
                .map(|m| {
                    m["inventory"][resource]
                        .as_str()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap()
                })
                .sum::<u64>();
        assert_eq!(
            total,
            market["data"]["resource_supply"][resource]
                .as_str()
                .unwrap()
                .parse::<u64>()?
        );
    }
    let history: Value = contract
        .view("get_recent_trades")
        .args_json(json!({"after_id":null,"limit":"50","expected_revision":"10"}))
        .await?
        .json()?;
    assert_eq!(history["data"]["items"].as_array().unwrap().len(), 4);
    println!("PURCHASE gas={gas}");
    Ok(())
}

#[tokio::test]
async fn an_intermediary_spends_its_own_player_assets_and_never_the_signers() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":contract.id(),"merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}
    })).transact().await?.into_result()?;
    let player = worker.dev_create_account().await?;
    player
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    let proxy = worker.dev_deploy(&fixture).await?;
    let before = contract.view_state().await?;
    let result = player
        .call(proxy.id(), "forward_purchase")
        .args_json(json!({"contract_id":contract.id(),"args":args()}))
        .max_gas()
        .transact()
        .await?;
    assert!(
        result
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_NOT_REGISTERED")
    );
    assert_eq!(contract.view_state().await?, before);
    player
        .call(proxy.id(), "forward_registration")
        .args_json(json!({"contract_id":contract.id()}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let bought: Value = player
        .call(proxy.id(), "forward_purchase")
        .args_json(json!({"contract_id":contract.id(),"args":args()}))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        bought["data"]["buyer"],
        json!({"kind":"player","account_id":proxy.id()})
    );
    assert_eq!(bought["data"]["buyer_gold_after"], "52");
    let signer: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":player.id()}))
        .await?
        .json()?;
    assert_eq!(signer["data"]["gold"], "100");
    assert_eq!(signer["data"]["inventory"]["crystal"], "0");
    let before = contract.view_state().await?;
    let stale = player
        .call(contract.id(), "buy_from_merchant")
        .args_json(args())
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
    let retry = player
        .call(proxy.id(), "forward_purchase")
        .args_json(json!({"contract_id":contract.id(),"args":args()}))
        .max_gas()
        .transact()
        .await?;
    assert!(
        retry
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_STALE_LISTING")
    );
    assert_eq!(contract.view_state().await?, before);
    let mut remainder = args();
    remainder["quantity"] = json!("3");
    remainder["max_total_price"] = json!("12");
    remainder["listing_version"] = json!("2");
    let own: Value = player
        .call(contract.id(), "buy_from_merchant")
        .args_json(remainder)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        own["data"]["buyer"],
        json!({"kind":"player","account_id":player.id()})
    );
    assert_eq!(own["data"]["buyer_gold_after"], "88");
    let proxy_state: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":proxy.id()}))
        .await?
        .json()?;
    assert_eq!(proxy_state["data"]["gold"], "52");
    assert_eq!(proxy_state["data"]["inventory"]["crystal"], "12");
    let before = contract.view_state().await?;
    assert!(
        player
            .call(contract.id(), "forward_purchase")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    Ok(())
}
