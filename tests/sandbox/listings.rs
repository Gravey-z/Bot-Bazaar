use super::wasm;
use anyhow::Result;
use near_workspaces::types::NearToken;
use serde_json::{Value, json};
use std::path::Path;

fn args() -> Value {
    json!({"merchant_id":"rex","resource":"crystal","unit_price":"7","quantity":"7","active":true,"expected_version":"1","action_id":"1"})
}

#[tokio::test]
async fn controller_listing_updates_and_failure_atomicity() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    assert!(
        rex.call(contract.id(), "set_listing")
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
    let before = contract.view_state().await?;
    for caller in [&attacker, &owner, &luna, &bolt, contract.as_account()] {
        let result = caller
            .call(contract.id(), "set_listing")
            .args_json(args())
            .transact()
            .await?;
        assert!(
            result
                .into_result()
                .unwrap_err()
                .to_string()
                .contains("BB:E_UNAUTHORIZED")
        );
        assert_eq!(contract.view_state().await?, before);
    }
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    let proxy = worker.dev_deploy(&fixture).await?;
    let forwarded = rex
        .call(proxy.id(), "forward_listing")
        .args_json(json!({"contract_id":contract.id(),"args":args()}))
        .max_gas()
        .transact()
        .await?;
    assert!(
        forwarded
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_UNAUTHORIZED")
    );
    assert_eq!(contract.view_state().await?, before);
    for (field, value, code) in [
        ("unit_price", "0", "BB:E_INVALID_PRICE"),
        ("unit_price", "101", "BB:E_INVALID_PRICE"),
        ("quantity", "0", "BB:E_INVALID_QUANTITY"),
        ("quantity", "101", "BB:E_INVALID_QUANTITY"),
        ("quantity", "16", "BB:E_INSUFFICIENT_STOCK"),
        ("expected_version", "0", "BB:E_STALE_LISTING"),
        ("action_id", "0", "BB:E_ACTION_USED"),
        ("action_id", "2", "BB:E_ACTION_GAP"),
    ] {
        let mut args = args();
        args[field] = json!(value);
        let result = rex
            .call(contract.id(), "set_listing")
            .args_json(args)
            .transact()
            .await?;
        assert!(result.into_result().unwrap_err().to_string().contains(code));
        assert_eq!(contract.view_state().await?, before);
    }
    for field in [
        "merchant_id",
        "resource",
        "unit_price",
        "quantity",
        "active",
        "expected_version",
        "action_id",
    ] {
        let mut invalid = args();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            rex.call(contract.id(), "set_listing")
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
        ("extra", json!("x")),
        ("merchant_id", json!("other")),
        ("resource", json!("gold")),
        ("merchant_id", json!({"rex":null})),
        ("unit_price", json!(7)),
        ("quantity", json!("01")),
        ("action_id", json!("-1")),
        ("action_id", json!("+1")),
        ("expected_version", json!(" 1")),
        ("unit_price", json!("18446744073709551616")),
        ("active", json!("true")),
        ("active", json!(1)),
        ("quantity", json!(null)),
    ] {
        let mut input = args();
        input[field] = value;
        malformed.push(input);
    }
    let mut invalid = args();
    invalid["active"] = json!(false);
    malformed.push(invalid);
    for invalid in malformed {
        assert!(
            rex.call(contract.id(), "set_listing")
                .args_json(invalid)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    let duplicate = br#"{"merchant_id":"rex","resource":"crystal","unit_price":"7","quantity":"7","active":true,"expected_version":"1","action_id":"1","action_id":"2"}"#.to_vec();
    assert!(
        rex.call(contract.id(), "set_listing")
            .args(duplicate)
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    assert!(
        rex.call(contract.id(), "set_listing")
            .args_json(args())
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    let mut same = args();
    same["unit_price"] = json!("4");
    same["quantity"] = json!("15");
    let unchanged = rex
        .call(contract.id(), "set_listing")
        .args_json(same)
        .transact()
        .await?;
    assert!(
        unchanged
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_NO_CHANGE")
    );
    assert_eq!(contract.view_state().await?, before);
    owner
        .call(contract.id(), "pause_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let paused = contract.view_state().await?;
    let result = rex
        .call(contract.id(), "set_listing")
        .args_json(args())
        .transact()
        .await?;
    assert!(
        result
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
    let success = rex.call(contract.id(),"set_listing")
        .args(br#"{ "resource":"crystal", "active":true, "quantity":"7", "unit_price":"7", "merchant_id":"rex", "action_id":"1", "expected_version":"1" }"#.to_vec())
        .transact().await?.into_result()?;
    let gas = success.total_gas_burnt.as_gas();
    let result: Value = success.json()?;
    assert_eq!(result["market_revision"], "4");
    assert_eq!(
        result["data"]["listing"],
        json!({"merchant_id":"rex","resource":"crystal","unit_price":"7","quantity":"7","active":true,"version":"2"})
    );
    assert_eq!(
        result["data"]["action"],
        json!({
            "action_id":"1","method":"set_listing","args_sha256":"3fce6ebef844b51a9bf3c3a6845c258dea2edc92ba36671dcbdcd2d650fc7390",
            "market_revision":"4","offer_id":null,"trade_id":null,"listing_version":"2"
        })
    );
    let before = contract.view_state().await?;
    for (version, action, code) in [
        ("2", "1", "BB:E_ACTION_USED"),
        ("1", "2", "BB:E_STALE_LISTING"),
        ("2", "3", "BB:E_ACTION_GAP"),
    ] {
        let mut input = args();
        input["expected_version"] = json!(version);
        input["action_id"] = json!(action);
        let result = rex
            .call(contract.id(), "set_listing")
            .args_json(input)
            .transact()
            .await?;
        assert!(result.into_result().unwrap_err().to_string().contains(code));
        assert_eq!(contract.view_state().await?, before);
    }
    let mut deactivate = args();
    deactivate["quantity"] = json!("0");
    deactivate["active"] = json!(false);
    deactivate["expected_version"] = json!("2");
    deactivate["action_id"] = json!("2");
    let result: Value = rex
        .call(contract.id(), "set_listing")
        .args_json(deactivate)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(result["data"]["listing"]["version"], "3");
    assert_eq!(result["data"]["listing"]["unit_price"], "7");
    assert_eq!(result["data"]["listing"]["quantity"], "0");
    assert_eq!(result["data"]["listing"]["active"], false);
    let mut reactivate = args();
    reactivate["quantity"] = json!("15");
    reactivate["expected_version"] = json!("3");
    reactivate["action_id"] = json!("3");
    rex.call(contract.id(), "set_listing")
        .args_json(reactivate)
        .transact()
        .await?
        .into_result()?;
    for (caller, merchant, resource, price, quantity) in [
        (&luna, "luna", "herb", "4", "5"),
        (&bolt, "bolt", "wood", "3", "10"),
    ] {
        let result: Value = caller
            .call(contract.id(), "set_listing")
            .args_json(json!({
                "merchant_id":merchant,"resource":resource,"unit_price":price,"quantity":quantity,
                "active":true,"expected_version":"1","action_id":"1"
            }))
            .transact()
            .await?
            .into_result()?
            .json()?;
        assert_eq!(result["data"]["listing"]["version"], "2");
        assert_eq!(result["data"]["action"]["action_id"], "1");
    }
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(market["market_revision"], "8");
    assert_eq!(market["data"]["total_issued_gold"], "550");
    assert_eq!(market["data"]["registered_player_count"], "0");
    assert_eq!(
        market["data"]["resource_supply"],
        seed["data"]["resource_supply"]
    );
    assert_eq!(market["data"]["next_offer_id"], "1");
    assert_eq!(market["data"]["next_trade_id"], "1");
    for index in 0..3 {
        assert_eq!(
            market["data"]["merchants"][index]["gold"],
            seed["data"]["merchants"][index]["gold"]
        );
        assert_eq!(
            market["data"]["merchants"][index]["inventory"],
            seed["data"]["merchants"][index]["inventory"]
        );
    }
    for (index, id) in ["rex", "luna", "bolt"].into_iter().enumerate() {
        let merchant: Value = contract
            .view("get_merchant")
            .args_json(json!({"merchant_id":id}))
            .await?
            .json()?;
        assert_eq!(merchant["data"], market["data"]["merchants"][index]);
    }
    let before = contract.view_state().await?;
    assert!(
        rex.call(contract.id(), "forward_listing")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    println!("SET_LISTING gas={gas}");
    Ok(())
}
