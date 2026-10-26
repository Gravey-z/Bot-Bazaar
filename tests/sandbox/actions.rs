use super::wasm;
use anyhow::Result;
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
use std::path::Path;

async fn market(contract: &Contract) -> Result<Value> {
    Ok(contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?)
}

async fn call(contract: &Contract, caller: &Account, method: &str, args: Value) -> Result<Value> {
    let result: Value = caller
        .call(contract.id(), method)
        .args_json(args.clone())
        .transact()
        .await?
        .into_result()?
        .json()?;
    let canonical = if method == "set_listing" {
        format!(
            r#"{{"args":{{"action_id":"{}","active":true,"expected_version":"{}","merchant_id":"rex","quantity":"2","resource":"crystal","unit_price":"{}"}},"method":"set_listing"}}"#,
            args["action_id"].as_str().unwrap(),
            args["expected_version"].as_str().unwrap(),
            args["unit_price"].as_str().unwrap()
        )
    } else {
        let ordered: std::collections::BTreeMap<String, Value> =
            serde_json::from_value(args.clone())?;
        format!(
            r#"{{"args":{},"method":"{method}"}}"#,
            serde_json::to_string(&ordered)?
        )
    };
    let digest: String = near_sdk::env::sha256_array(canonical.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(result["data"]["action"]["args_sha256"], digest);
    assert_eq!(result["data"]["action"]["action_id"], args["action_id"]);
    assert_eq!(result["data"]["action"]["method"], method);
    let state = market(contract).await?;
    let merchant = state["data"]["merchants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["controller_account_id"] == caller.id().as_str())
        .unwrap();
    assert_eq!(merchant["last_action"], result["data"]["action"]);
    Ok(result)
}

async fn reject(
    contract: &Contract,
    caller: &Account,
    method: &str,
    args: Value,
    code: &str,
) -> Result<()> {
    let before = contract.view_state().await?;
    let result = caller
        .call(contract.id(), method)
        .args_json(args)
        .transact()
        .await?;
    assert!(result.into_result().unwrap_err().to_string().contains(code));
    assert_eq!(contract.view_state().await?, before);
    Ok(())
}

fn listing(action: u64, price: u64, version: u64) -> Value {
    json!({"merchant_id":"rex","resource":"crystal","unit_price":price.to_string(),"quantity":"2","active":true,"expected_version":version.to_string(),"action_id":action.to_string()})
}

fn proposal(proposer: &str, action: u64, expiry: u64) -> Value {
    json!({"proposer":proposer,"buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"24","expires_at_ns":expiry.to_string(),"action_id":action.to_string()})
}

#[tokio::test]
async fn shared_action_sequence_and_replays_survive_receipt_replacement_and_history_pruning()
-> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let production = wasm()?;
    let contract = worker.dev_deploy(&production).await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({"owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":"bolt.testnet"}})).transact().await?.into_result()?;
    let now = market(&contract).await?["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    let expiry = now + 500_000_000_000;
    call(&contract, &rex, "set_listing", listing(1, 5, 1)).await?;
    reject(
        &contract,
        &rex,
        "propose_trade",
        proposal("rex", 1, expiry),
        "BB:E_ACTION_USED",
    )
    .await?;
    reject(
        &contract,
        &rex,
        "propose_trade",
        proposal("rex", 3, expiry),
        "BB:E_ACTION_GAP",
    )
    .await?;
    let invalid = json!({"proposer":"rex","buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"23","expires_at_ns":expiry.to_string(),"action_id":"2"});
    reject(
        &contract,
        &rex,
        "propose_trade",
        invalid,
        "BB:E_NON_INTEGER_UNIT_PRICE",
    )
    .await?;
    let proposal_args = proposal("rex", 2, expiry);
    call(&contract, &rex, "propose_trade", proposal_args.clone()).await?;
    reject(
        &contract,
        &rex,
        "propose_trade",
        proposal_args.clone(),
        "BB:E_ACTION_USED",
    )
    .await?;
    let mut changed = proposal_args.clone();
    changed["total_price"] = json!("28");
    reject(
        &contract,
        &rex,
        "propose_trade",
        changed,
        "BB:E_ACTION_USED",
    )
    .await?;
    reject(
        &contract,
        &rex,
        "cancel_trade",
        json!({"offer_id":"1","action_id":"2"}),
        "BB:E_ACTION_USED",
    )
    .await?;
    call(
        &contract,
        &rex,
        "cancel_trade",
        json!({"offer_id":"1","action_id":"3"}),
    )
    .await?;
    call(
        &contract,
        &luna,
        "propose_trade",
        proposal("luna", 1, expiry),
    )
    .await?;
    reject(
        &contract,
        &rex,
        "accept_trade",
        json!({"offer_id":"2","action_id":"3"}),
        "BB:E_ACTION_USED",
    )
    .await?;
    reject(
        &contract,
        &rex,
        "accept_trade",
        json!({"offer_id":"2","action_id":"5"}),
        "BB:E_ACTION_GAP",
    )
    .await?;
    let accepted = call(
        &contract,
        &rex,
        "accept_trade",
        json!({"offer_id":"2","action_id":"4"}),
    )
    .await?;
    reject(
        &contract,
        &rex,
        "set_listing",
        listing(4, 7, 3),
        "BB:E_ACTION_USED",
    )
    .await?;
    call(&contract, &rex, "set_listing", listing(5, 7, 3)).await?;
    let before_pruning = market(&contract).await?;
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&fixture)
        .transact()
        .await?
        .into_result()?;
    for _ in 0..10 {
        contract
            .call("fill_history")
            .args_json(json!({"count":10}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    contract
        .as_account()
        .batch(contract.id())
        .deploy(&production)
        .transact()
        .await?
        .into_result()?;
    let after_pruning = market(&contract).await?;
    assert_eq!(
        after_pruning["data"]["merchants"],
        before_pruning["data"]["merchants"]
    );
    assert_eq!(
        after_pruning["market_revision"],
        before_pruning["market_revision"]
    );
    assert_eq!(after_pruning["data"]["offers_pruned_through"], "2");
    assert_eq!(after_pruning["data"]["trades_pruned_through"], "1");
    for id in ["1", "2"] {
        let lookup: Value = contract
            .view("get_offer")
            .args_json(json!({"offer_id":id}))
            .await?
            .json()?;
        assert_eq!(lookup["data"]["kind"], "pruned");
    }
    reject(
        &contract,
        &rex,
        "propose_trade",
        proposal_args,
        "BB:E_ACTION_USED",
    )
    .await?;
    reject(
        &contract,
        &rex,
        "set_listing",
        listing(1, 6, 1),
        "BB:E_ACTION_USED",
    )
    .await?;
    reject(
        &contract,
        &rex,
        "accept_trade",
        json!({"offer_id":"2","action_id":"4"}),
        "BB:E_OFFER_PRUNED",
    )
    .await?;
    reject(
        &contract,
        &rex,
        "cancel_trade",
        json!({"offer_id":"1","action_id":"3"}),
        "BB:E_OFFER_PRUNED",
    )
    .await?;
    let current = call(&contract, &rex, "propose_trade", proposal("rex", 6, expiry)).await?;
    assert_eq!(current["data"]["offer"]["offer_id"], "103");
    let final_state = market(&contract).await?;
    assert_eq!(
        final_state["data"]["merchants"][0]["gold"],
        accepted["data"]["trade"]["buyer_gold_after"]
    );
    assert_eq!(
        final_state["data"]["merchants"][1]["gold"],
        accepted["data"]["trade"]["seller_gold_after"]
    );
    assert_eq!(final_state["data"]["next_trade_id"], "102");
    assert_eq!(final_state["data"]["merchants"][0]["last_action_id"], "6");
    assert_eq!(final_state["data"]["merchants"][1]["last_action_id"], "1");
    println!("ACTION_RETRIES methods=4 history_pruned=true next_rex_action=7 next_offer=104");
    Ok(())
}
