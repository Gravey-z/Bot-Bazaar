use super::wasm;
use anyhow::Result;
use near_workspaces::{Account, Contract, operations::Function, result::ExecutionSuccess};
use serde_json::{Value, json};

pub(super) fn assert_event(
    success: &ExecutionSuccess,
    method: &str,
    caller: &str,
    snapshot: &Value,
) -> Result<()> {
    assert!(success.failures().is_empty());
    let logs: Vec<_> = success
        .logs()
        .into_iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .collect();
    assert_eq!(logs.len(), 1);
    let parsed: Value = serde_json::from_str(logs[0])?;
    assert_eq!(
        parsed,
        json!({"standard":"bot_bazaar","version":"1.0.0","event":method,"data":[{
            "initiator_account_id":caller,"market_revision":snapshot["market_revision"],
            "block_height":snapshot["block_height"],"block_timestamp_ns":snapshot["block_timestamp_ns"],"result":snapshot["data"]
        }]})
    );
    for key in ["market_revision", "block_height", "block_timestamp_ns"] {
        assert!(parsed["data"][0][key].as_str().unwrap().parse::<u64>()? > 0);
    }
    for outcome in success.receipt_outcomes() {
        if outcome
            .logs
            .iter()
            .any(|log| log.starts_with("EVENT_JSON:"))
        {
            assert!(outcome.is_success());
        }
    }
    Ok(())
}

async fn call(contract: &Contract, caller: &Account, method: &str, args: Value) -> Result<Value> {
    let success = caller
        .call(contract.id(), method)
        .args_json(args)
        .transact()
        .await?
        .into_result()?;
    let snapshot: Value = success.json()?;
    assert_event(&success, method, caller.id().as_str(), &snapshot)?;
    Ok(snapshot)
}

async fn propose(contract: &Contract, rex: &Account, action: u64) -> Result<()> {
    let state: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    let now = state["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    call(contract,rex,"propose_trade",json!({"proposer":"rex","buyer":"rex","seller":"luna","resource":"crystal","quantity":"1","total_price":"6","expires_at_ns":(now+500_000_000_000).to_string(),"action_id":action.to_string()})).await?;
    Ok(())
}

#[tokio::test]
async fn public_events_match_results_and_no_change_or_validation_failure_emit_none() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    let initialized=contract.call("initialize_market").args_json(json!({"owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":"bolt.testnet"}})).transact().await?.into_result()?;
    assert!(initialized.raw_bytes()?.is_empty());
    let seed: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    let init_log = initialized
        .logs()
        .into_iter()
        .find_map(|log| log.strip_prefix("EVENT_JSON:"))
        .unwrap();
    let event: Value = serde_json::from_str(init_log)?;
    let snapshot = json!({"market_revision":"1","block_height":event["data"][0]["block_height"],"block_timestamp_ns":event["data"][0]["block_timestamp_ns"],"data":seed["data"]});
    assert_event(
        &initialized,
        "initialize_market",
        contract.id().as_str(),
        &snapshot,
    )?;
    call(&contract, &player, "register_player", json!({})).await?;
    call(&contract,&rex,"set_listing",json!({"merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"2","active":true,"expected_version":"1","action_id":"1"})).await?;
    call(&contract,&player,"buy_from_merchant",json!({"merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"5","listing_version":"2"})).await?;
    propose(&contract, &rex, 2).await?;
    call(
        &contract,
        &luna,
        "accept_trade",
        json!({"offer_id":"1","action_id":"1"}),
    )
    .await?;
    propose(&contract, &rex, 3).await?;
    call(
        &contract,
        &rex,
        "cancel_trade",
        json!({"offer_id":"2","action_id":"4"}),
    )
    .await?;
    call(&contract, &owner, "pause_market", json!({})).await?;
    let unchanged = owner
        .call(contract.id(), "pause_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    assert!(unchanged.logs().is_empty());
    let no_change: Value = unchanged.json()?;
    assert_eq!(no_change["market_revision"], "9");
    assert_eq!(no_change["data"]["changed"], false);
    call(&contract, &owner, "resume_market", json!({})).await?;
    let unchanged = owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    assert!(unchanged.logs().is_empty());
    let no_change: Value = unchanged.json()?;
    assert_eq!(no_change["market_revision"], "10");
    let ignored = player
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":["1","2","999"]}))
        .transact()
        .await?
        .into_result()?;
    assert!(ignored.logs().is_empty());
    let no_change: Value = ignored.json()?;
    assert_eq!(no_change["market_revision"], "10");
    for (caller, method, args) in [
        (&player, "register_player", json!({})),
        (
            &rex,
            "cancel_trade",
            json!({"offer_id":"2","action_id":"5"}),
        ),
        (&player, "pause_market", json!({})),
        (&player, "expire_offers", json!({"offer_ids":[]})),
        (&rex, "set_listing", json!({})),
    ] {
        let before = contract.view_state().await?;
        let failure = caller
            .call(contract.id(), method)
            .args_json(args)
            .transact()
            .await?;
        assert!(failure.is_failure());
        assert!(
            !failure
                .logs()
                .iter()
                .any(|log| log.starts_with("EVENT_JSON:"))
        );
        assert_eq!(contract.view_state().await?, before);
    }
    for (method, args) in [
        ("get_market_state", json!({})),
        ("get_player", json!({"account_id":player.id()})),
        ("get_merchant", json!({"merchant_id":"rex"})),
        ("get_offer", json!({"offer_id":"1"})),
        (
            "get_offers_for_merchant",
            json!({"merchant_id":"rex","status":"all","after_id":null,"limit":"50","expected_revision":null}),
        ),
        (
            "get_recent_trades",
            json!({"after_id":null,"limit":"50","expected_revision":null}),
        ),
    ] {
        let view = contract.view(method).args_json(args).await?;
        assert!(view.logs.is_empty());
    }
    let final_state: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(final_state["market_revision"], "10");
    println!("EVENTS initialization_and_mutations=10 unchanged_or_rejected_emit_none=true");
    Ok(())
}

#[tokio::test]
async fn an_event_from_a_failed_receipt_is_not_committed_state() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let player = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({"owner_account_id":contract.id(),"merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}})).transact().await?.into_result()?;
    let before = contract.view_state().await?;
    let failed = player
        .batch(contract.id())
        .call(Function::new("register_player").args_json(json!({})))
        .call(Function::new("missing_method").args_json(json!({})))
        .transact()
        .await?;
    assert!(failed.is_failure());
    let events: Vec<_> = failed
        .logs()
        .into_iter()
        .filter(|log| log.starts_with("EVENT_JSON:"))
        .collect();
    assert_eq!(events.len(), 1);
    assert!(failed.receipt_failures().iter().any(|outcome| {
        outcome
            .logs
            .iter()
            .any(|log| log.starts_with("EVENT_JSON:"))
    }));
    assert_eq!(contract.view_state().await?, before);
    let success = player
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let result: Value = success.json()?;
    assert_event(&success, "register_player", player.id().as_str(), &result)?;
    assert_eq!(result["market_revision"], "2");
    assert_eq!(result["data"]["gold"], "100");
    Ok(())
}
