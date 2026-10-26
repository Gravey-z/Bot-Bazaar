use super::wasm;
use anyhow::Result;
use near_workspaces::{Account, Contract, types::NearToken};
use serde_json::{Value, json};
use std::path::Path;

async fn market(contract: &Contract) -> Result<Value> {
    Ok(contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?)
}

#[allow(clippy::too_many_arguments)]
async fn propose(
    contract: &Contract,
    caller: &Account,
    proposer: &str,
    buyer: &str,
    seller: &str,
    quantity: u64,
    total: u64,
    action: u64,
) -> Result<Value> {
    let now = market(contract).await?["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    Ok(caller.call(contract.id(),"propose_trade").args_json(json!({"proposer":proposer,"buyer":buyer,"seller":seller,"resource":"crystal","quantity":quantity.to_string(),"total_price":total.to_string(),"expires_at_ns":(now+500_000_000_000).to_string(),"action_id":action.to_string()})).transact().await?.into_result()?.json()?)
}

async fn rejected(contract: &Contract, caller: &Account, args: Value, code: &str) -> Result<()> {
    let before = contract.view_state().await?;
    let result = caller
        .call(contract.id(), "accept_trade")
        .args_json(args)
        .transact()
        .await?;
    assert!(result.into_result().unwrap_err().to_string().contains(code));
    assert_eq!(contract.view_state().await?, before);
    Ok(())
}

#[tokio::test]
async fn public_acceptance_settles_fixture_with_stored_roles_and_exact_terms() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    let args = json!({"offer_id":"1","action_id":"1"});
    assert!(
        luna.call(contract.id(), "accept_trade")
            .args_json(args.clone())
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert!(contract.view_state().await?.is_empty());
    contract.call("initialize_market").args_json(json!({"owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}})).transact().await?.into_result()?;
    let seed = market(&contract).await?;
    player
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    player.call(contract.id(),"buy_from_merchant").args_json(json!({"merchant_id":"rex","resource":"crystal","quantity":"12","max_total_price":"48","listing_version":"1"})).transact().await?.into_result()?;
    let proposal = propose(&contract, &rex, "rex", "rex", "luna", 4, 24, 1).await?;
    for caller in [&rex, &owner, &bolt, &player, contract.as_account()] {
        rejected(&contract, caller, args.clone(), "BB:E_UNAUTHORIZED").await?;
    }
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    let proxy = worker.dev_deploy(&fixture).await?;
    let before = contract.view_state().await?;
    let forwarded = luna
        .call(proxy.id(), "forward_acceptance")
        .args_json(json!({"contract_id":contract.id(),"args":args}))
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
    for (invalid, code) in [
        (
            json!({"offer_id":"0","action_id":"1"}),
            "BB:E_INVALID_ARGUMENT",
        ),
        (
            json!({"offer_id":"2","action_id":"1"}),
            "BB:E_OFFER_NOT_FOUND",
        ),
        (json!({"offer_id":"1","action_id":"0"}), "BB:E_ACTION_USED"),
        (json!({"offer_id":"1","action_id":"2"}), "BB:E_ACTION_GAP"),
    ] {
        rejected(&contract, &luna, invalid, code).await?;
    }
    for invalid in [
        json!({}),
        json!({"offer_id":"1"}),
        json!({"action_id":"1"}),
        json!([]),
        json!(null),
        json!({"offer_id":"1","action_id":"1","counterparty":"luna"}),
        json!({"offer_id":1,"action_id":"1"}),
        json!({"offer_id":"01","action_id":"1"}),
        json!({"offer_id":"-1","action_id":"1"}),
        json!({"offer_id":"18446744073709551616","action_id":"1"}),
        json!({"offer_id":"1","action_id":null}),
        json!({"offer_id":"1","action_id":true}),
    ] {
        assert!(
            luna.call(contract.id(), "accept_trade")
                .args_json(invalid)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    assert!(
        luna.call(contract.id(), "accept_trade")
            .args(br#"{"offer_id":"1","action_id":"1","action_id":"1"}"#.to_vec())
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    assert!(
        luna.call(contract.id(), "accept_trade")
            .args_json(args.clone())
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    owner
        .call(contract.id(), "pause_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    rejected(&contract, &luna, args.clone(), "BB:E_MARKET_PAUSED").await?;
    owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    luna.call(contract.id(),"set_listing").args_json(json!({"merchant_id":"luna","resource":"crystal","unit_price":"9","quantity":"2","active":true,"expected_version":"1","action_id":"1"})).transact().await?.into_result()?;
    rejected(&contract, &luna, args, "BB:E_ACTION_USED").await?;
    let success = luna
        .call(contract.id(), "accept_trade")
        .args(br#"{ "action_id":"2", "offer_id":"1" }"#.to_vec())
        .transact()
        .await?
        .into_result()?;
    println!("ACCEPTANCE gas={}", success.total_gas_burnt.as_gas());
    let result: Value = success.json()?;
    assert_eq!(result["market_revision"], "8");
    let trade = &result["data"]["trade"];
    assert_eq!(
        *trade,
        json!({"trade_id":"2","kind":"merchant_trade","buyer":{"kind":"merchant","merchant_id":"rex"},"seller":{"kind":"merchant","merchant_id":"luna"},"resource":"crystal","quantity":"4","unit_price":"6","total_price":"24","offer_id":"1","buyer_gold_after":"204","seller_gold_after":"244","buyer_resource_after":"7","seller_resource_after":"8","settled_at_ns":result["block_timestamp_ns"],"market_revision":"8"})
    );
    let mut expected_offer = proposal["data"]["offer"].clone();
    expected_offer["status"] = json!("accepted");
    expected_offer["closed_at_ns"] = result["block_timestamp_ns"].clone();
    expected_offer["settled_trade_id"] = json!("2");
    assert_eq!(result["data"]["offer"], expected_offer);
    let digest: String = near_sdk::env::sha256_array(
        br#"{"args":{"action_id":"2","offer_id":"1"},"method":"accept_trade"}"#,
    )
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect();
    assert_eq!(
        result["data"]["action"],
        json!({"action_id":"2","method":"accept_trade","args_sha256":digest,"market_revision":"8","offer_id":"1","trade_id":"2","listing_version":null})
    );
    let lookup: Value = contract
        .view("get_offer")
        .args_json(json!({"offer_id":"1"}))
        .await?
        .json()?;
    assert_eq!(lookup["data"]["offer"], expected_offer);
    let state = market(&contract).await?;
    assert_eq!(
        state["data"]["merchants"][0]["listings"][0]["quantity"],
        "3"
    );
    assert_eq!(state["data"]["merchants"][0]["listings"][0]["version"], "3");
    assert_eq!(
        state["data"]["merchants"][1]["listings"][0]["quantity"],
        "2"
    );
    assert_eq!(
        state["data"]["merchants"][1]["listings"][0]["unit_price"],
        "9"
    );
    assert_eq!(state["data"]["merchants"][1]["listings"][0]["version"], "3");
    assert_eq!(
        state["data"]["merchants"][1]["last_action"],
        result["data"]["action"]
    );
    assert_eq!(
        state["data"]["merchants"][0]["last_action"],
        proposal["data"]["action"]
    );
    assert_eq!(state["data"]["merchants"][2], seed["data"]["merchants"][2]);
    for index in 0..2 {
        for resource in 1..4 {
            assert_eq!(
                state["data"]["merchants"][index]["listings"][resource],
                seed["data"]["merchants"][index]["listings"][resource]
            );
        }
    }
    let player_state: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":player.id()}))
        .await?
        .json()?;
    let mut total_gold = player_state["data"]["gold"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    for merchant in state["data"]["merchants"].as_array().unwrap() {
        total_gold += merchant["gold"].as_str().unwrap().parse::<u64>()?;
    }
    assert_eq!(total_gold, 650);
    for resource in ["crystal", "wood", "herb", "iron"] {
        let mut total = player_state["data"]["inventory"][resource]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        for merchant in state["data"]["merchants"].as_array().unwrap() {
            total += merchant["inventory"][resource]
                .as_str()
                .unwrap()
                .parse::<u64>()?;
        }
        assert_eq!(
            total,
            state["data"]["resource_supply"][resource]
                .as_str()
                .unwrap()
                .parse::<u64>()?
        );
    }
    rejected(
        &contract,
        &luna,
        json!({"offer_id":"1","action_id":"2"}),
        "BB:E_OFFER_ACCEPTED",
    )
    .await?;
    rejected(
        &contract,
        &luna,
        json!({"offer_id":"1","action_id":"3"}),
        "BB:E_OFFER_ACCEPTED",
    )
    .await?;
    let history: Value = contract
        .view("get_recent_trades")
        .args_json(json!({"after_id":null,"limit":"50","expected_revision":null}))
        .await?
        .json()?;
    assert_eq!(history["data"]["items"][1], *trade);
    propose(&contract, &luna, "luna", "bolt", "luna", 1, 6, 3).await?;
    let buyer_acceptance: Value = bolt
        .call(contract.id(), "accept_trade")
        .args_json(json!({"offer_id":"2","action_id":"1"}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        buyer_acceptance["data"]["trade"]["buyer"],
        json!({"kind":"merchant","merchant_id":"bolt"})
    );
    let after = market(&contract).await?;
    assert_eq!(
        after["data"]["merchants"][2]["listings"][0]["quantity"],
        "0"
    );
    assert_eq!(
        after["data"]["merchants"][2]["listings"][0]["active"],
        false
    );
    assert_eq!(after["data"]["merchants"][2]["listings"][0]["version"], "2");
    let pending:Value=contract.view("get_offers_for_merchant").args_json(json!({"merchant_id":"luna","status":"pending","after_id":null,"limit":"50","expected_revision":null})).await?.json()?;
    assert!(pending["data"]["items"].as_array().unwrap().is_empty());
    let before = contract.view_state().await?;
    assert!(
        contract
            .call("forward_acceptance")
            .args_json(json!({}))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    Ok(())
}

#[tokio::test]
async fn acceptance_rechecks_stock_spent_after_proposal_and_competing_funds() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    for stock_case in [true, false] {
        let contract = worker.dev_deploy(&wasm()?).await?;
        let rex = worker.dev_create_account().await?;
        let luna = worker.dev_create_account().await?;
        let bolt = worker.dev_create_account().await?;
        contract.call("initialize_market").args_json(json!({"owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}})).transact().await?.into_result()?;
        if stock_case {
            propose(&contract, &rex, "rex", "rex", "luna", 10, 10, 1).await?;
            let player = worker.dev_create_account().await?;
            player
                .call(contract.id(), "register_player")
                .args_json(json!({}))
                .transact()
                .await?
                .into_result()?;
            player.call(contract.id(),"buy_from_merchant").args_json(json!({"merchant_id":"luna","resource":"crystal","quantity":"8","max_total_price":"48","listing_version":"1"})).transact().await?.into_result()?;
            rejected(
                &contract,
                &luna,
                json!({"offer_id":"1","action_id":"1"}),
                "BB:E_INSUFFICIENT_STOCK",
            )
            .await?;
            let pending: Value = contract
                .view("get_offer")
                .args_json(json!({"offer_id":"1"}))
                .await?
                .json()?;
            assert_eq!(pending["data"]["offer"]["status"], "pending");
            propose(&contract, &rex, "rex", "luna", "rex", 6, 6, 2).await?;
            luna.call(contract.id(), "accept_trade")
                .args_json(json!({"offer_id":"2","action_id":"1"}))
                .transact()
                .await?
                .into_result()?;
            let recovered: Value = luna
                .call(contract.id(), "accept_trade")
                .args_json(json!({"offer_id":"1","action_id":"2"}))
                .transact()
                .await?
                .into_result()?
                .json()?;
            assert_eq!(recovered["data"]["trade"]["seller_resource_after"], "0");
            let after = market(&contract).await?;
            assert_eq!(
                after["data"]["merchants"][1]["listings"][0]["active"],
                false
            );
            assert_eq!(after["data"]["merchants"][1]["listings"][0]["version"], "4");
        } else {
            propose(&contract, &rex, "rex", "rex", "luna", 2, 100, 1).await?;
            propose(&contract, &rex, "rex", "rex", "bolt", 2, 100, 2).await?;
            luna.call(contract.id(), "accept_trade")
                .args_json(json!({"offer_id":"1","action_id":"1"}))
                .transact()
                .await?
                .into_result()?;
            rejected(
                &contract,
                &bolt,
                json!({"offer_id":"2","action_id":"1"}),
                "BB:E_INSUFFICIENT_GOLD",
            )
            .await?;
            let state = market(&contract).await?;
            assert_eq!(state["data"]["merchants"][0]["gold"], "80");
            assert_eq!(state["data"]["next_trade_id"], "2");
            let pending: Value = contract
                .view("get_offer")
                .args_json(json!({"offer_id":"2"}))
                .await?
                .json()?;
            assert_eq!(pending["data"]["offer"]["status"], "pending");
        }
    }
    Ok(())
}
