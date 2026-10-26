use super::wasm;
use anyhow::Result;
use bot_bazaar_market::state::MarketState;
use near_sdk::borsh;
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

async fn propose(
    contract: &Contract,
    caller: &Account,
    proposer: &str,
    action: u64,
) -> Result<Value> {
    let now = market(contract).await?["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    Ok(caller.call(contract.id(),"propose_trade").args_json(json!({"proposer":proposer,"buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"24","expires_at_ns":(now+500_000_000_000).to_string(),"action_id":action.to_string()})).transact().await?.into_result()?.json()?)
}

async fn rejected(
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

#[tokio::test]
async fn public_cancellation_checks_proposer_wire_and_pause_without_moving_assets() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let args = json!({"offer_id":"1","action_id":"2"});
    assert!(
        rex.call(contract.id(), "cancel_trade")
            .args_json(args.clone())
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert!(contract.view_state().await?.is_empty());
    contract.call("initialize_market").args_json(json!({"owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}})).transact().await?.into_result()?;
    let proposal = propose(&contract, &rex, "rex", 1).await?;
    let before_market = market(&contract).await?;
    for caller in [&owner, &luna, &bolt, &attacker, contract.as_account()] {
        rejected(
            &contract,
            caller,
            "cancel_trade",
            args.clone(),
            "BB:E_UNAUTHORIZED",
        )
        .await?;
    }
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    let proxy = worker.dev_deploy(&fixture).await?;
    let before = contract.view_state().await?;
    let forwarded = rex
        .call(proxy.id(), "forward_cancellation")
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
            json!({"offer_id":"0","action_id":"2"}),
            "BB:E_INVALID_ARGUMENT",
        ),
        (
            json!({"offer_id":"2","action_id":"2"}),
            "BB:E_OFFER_NOT_FOUND",
        ),
        (json!({"offer_id":"1","action_id":"1"}), "BB:E_ACTION_USED"),
        (json!({"offer_id":"1","action_id":"3"}), "BB:E_ACTION_GAP"),
    ] {
        rejected(&contract, &rex, "cancel_trade", invalid, code).await?;
    }
    for invalid in [
        json!({}),
        json!({"offer_id":"1"}),
        json!({"action_id":"2"}),
        json!([]),
        json!(null),
        json!({"offer_id":"1","action_id":"2","proposer":"rex"}),
        json!({"offer_id":1,"action_id":"2"}),
        json!({"offer_id":"01","action_id":"2"}),
        json!({"offer_id":"-1","action_id":"2"}),
        json!({"offer_id":"18446744073709551616","action_id":"2"}),
        json!({"offer_id":"1","action_id":null}),
        json!({"offer_id":"1","action_id":true}),
        json!({"offer_id":"1","action_id":"+2"}),
    ] {
        assert!(
            rex.call(contract.id(), "cancel_trade")
                .args_json(invalid)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    assert!(
        rex.call(contract.id(), "cancel_trade")
            .args(br#"{"offer_id":"1","action_id":"2","action_id":"2"}"#.to_vec())
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    assert!(
        rex.call(contract.id(), "cancel_trade")
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
    let success = rex
        .call(contract.id(), "cancel_trade")
        .args(br#"{ "action_id":"2", "offer_id":"1" }"#.to_vec())
        .transact()
        .await?
        .into_result()?;
    println!("CANCELLATION gas={}", success.total_gas_burnt.as_gas());
    let result: Value = success.json()?;
    assert_eq!(result["market_revision"], "4");
    let mut expected = proposal["data"]["offer"].clone();
    expected["status"] = json!("cancelled");
    expected["closed_at_ns"] = result["block_timestamp_ns"].clone();
    assert_eq!(result["data"]["offer"], expected);
    let digest: String = near_sdk::env::sha256_array(
        br#"{"args":{"action_id":"2","offer_id":"1"},"method":"cancel_trade"}"#,
    )
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect();
    assert_eq!(
        result["data"]["action"],
        json!({"action_id":"2","method":"cancel_trade","args_sha256":digest,"market_revision":"4","offer_id":"1","trade_id":null,"listing_version":null})
    );
    let after = market(&contract).await?;
    assert_eq!(after["data"]["paused"], true);
    for (old, new) in before_market["data"]["merchants"]
        .as_array()
        .unwrap()
        .iter()
        .zip(after["data"]["merchants"].as_array().unwrap())
    {
        for field in ["gold", "inventory", "listings"] {
            assert_eq!(old[field], new[field]);
        }
    }
    for field in [
        "total_issued_gold",
        "resource_supply",
        "registered_player_count",
        "next_offer_id",
        "next_trade_id",
    ] {
        assert_eq!(before_market["data"][field], after["data"][field]);
    }
    assert_eq!(
        after["data"]["merchants"][0]["last_action"],
        result["data"]["action"]
    );
    for index in 1..3 {
        assert_eq!(
            after["data"]["merchants"][index],
            before_market["data"]["merchants"][index]
        );
    }
    let raw = contract.view_state().await?;
    let stored: MarketState = borsh::from_slice(raw.get(b"STATE".as_slice()).unwrap())?;
    assert!(stored.pending_offer_ids.iter().all(Option::is_none));
    assert!(stored.merchants.iter().all(|m| m.pending_offer_count == 0));
    let lookup: Value = contract
        .view("get_offer")
        .args_json(json!({"offer_id":"1"}))
        .await?
        .json()?;
    assert_eq!(lookup["data"]["offer"], expected);
    for action in ["2", "3"] {
        rejected(
            &contract,
            &rex,
            "cancel_trade",
            json!({"offer_id":"1","action_id":action}),
            "BB:E_OFFER_CANCELLED",
        )
        .await?;
    }
    owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    rejected(
        &contract,
        &luna,
        "accept_trade",
        json!({"offer_id":"1","action_id":"1"}),
        "BB:E_OFFER_CANCELLED",
    )
    .await?;
    let cleanup: Value = attacker
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":["1"]}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(cleanup["data"]["ignored_offer_ids"], json!(["1"]));
    rejected(
        &contract,
        &luna,
        "accept_trade",
        json!({"offer_id":"1","action_id":"1"}),
        "BB:E_OFFER_CANCELLED",
    )
    .await?;
    propose(&contract, &luna, "luna", 1).await?;
    luna.call(contract.id(), "cancel_trade")
        .args_json(json!({"offer_id":"2","action_id":"2"}))
        .transact()
        .await?
        .into_result()?;
    propose(&contract, &rex, "rex", 3).await?;
    luna.call(contract.id(), "accept_trade")
        .args_json(json!({"offer_id":"3","action_id":"3"}))
        .transact()
        .await?
        .into_result()?;
    rejected(
        &contract,
        &rex,
        "cancel_trade",
        json!({"offer_id":"3","action_id":"4"}),
        "BB:E_OFFER_ACCEPTED",
    )
    .await?;
    let before = contract.view_state().await?;
    assert!(
        contract
            .call("forward_cancellation")
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
async fn cancellation_and_acceptance_race_can_only_close_an_offer_once() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({"owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":"bolt.testnet"}})).transact().await?.into_result()?;
    let mut settlements = 0;
    for id in 1..=2 {
        let before = market(&contract).await?;
        let rex_action = before["data"]["merchants"][0]["last_action_id"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 1;
        let luna_action = before["data"]["merchants"][1]["last_action_id"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 1;
        propose(&contract, &rex, "rex", rex_action).await?;
        let (cancel, accept) = tokio::join!(
            rex.call(contract.id(), "cancel_trade")
                .args_json(
                    json!({"offer_id":id.to_string(),"action_id":(rex_action+1).to_string()})
                )
                .transact(),
            luna.call(contract.id(), "accept_trade")
                .args_json(json!({"offer_id":id.to_string(),"action_id":luna_action.to_string()}))
                .transact()
        );
        let cancel = cancel?.into_result();
        let accept = accept?.into_result();
        assert_ne!(cancel.is_ok(), accept.is_ok());
        let lookup: Value = contract
            .view("get_offer")
            .args_json(json!({"offer_id":id.to_string()}))
            .await?
            .json()?;
        if let Err(error) = &accept {
            assert_eq!(lookup["data"]["offer"]["status"], "cancelled");
            assert!(error.to_string().contains("BB:E_OFFER_CANCELLED"));
        } else {
            settlements += 1;
            assert_eq!(lookup["data"]["offer"]["status"], "accepted");
            assert!(
                cancel
                    .as_ref()
                    .unwrap_err()
                    .to_string()
                    .contains("BB:E_OFFER_ACCEPTED")
            );
        }
        let after = market(&contract).await?;
        assert_eq!(
            after["data"]["next_trade_id"],
            (settlements + 1).to_string()
        );
        assert_eq!(after["market_revision"], (1 + id * 2).to_string());
        assert_eq!(
            after["data"]["merchants"][0]["gold"],
            (180 - settlements * 24).to_string()
        );
        assert_eq!(
            after["data"]["merchants"][1]["gold"],
            (220 + settlements * 24).to_string()
        );
        assert_eq!(
            after["data"]["merchants"][0]["inventory"]["crystal"],
            (15 + settlements * 4).to_string()
        );
        assert_eq!(
            after["data"]["merchants"][1]["inventory"]["crystal"],
            (12 - settlements * 4).to_string()
        );
        assert_eq!(
            after["data"]["merchants"][0]["last_action_id"],
            (rex_action + u64::from(cancel.is_ok())).to_string()
        );
        assert_eq!(
            after["data"]["merchants"][1]["last_action_id"],
            (luna_action - u64::from(accept.is_err())).to_string()
        );
        let raw = contract.view_state().await?;
        let state: MarketState = borsh::from_slice(raw.get(b"STATE".as_slice()).unwrap())?;
        assert!(state.pending_offer_ids.iter().all(Option::is_none));
        assert!(state.merchants.iter().all(|m| m.pending_offer_count == 0));
    }
    println!("CANCEL_ACCEPT_RACES rounds=2 closures=2 settlements={settlements}");
    Ok(())
}
