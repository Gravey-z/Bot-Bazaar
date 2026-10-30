use super::wasm;
use anyhow::Result;
use bot_bazaar_market::state::MarketState;
use near_sdk::borsh;
use near_workspaces::{Account, Contract, types::NearToken};
use serde_json::{Value, json};
use std::path::Path;

fn args(expiry: u64) -> Value {
    json!({"proposer":"rex","buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"24","expires_at_ns":expiry.to_string(),"action_id":"1"})
}

async fn market(contract: &Contract) -> Result<Value> {
    Ok(contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?)
}

async fn rejected(contract: &Contract, caller: &Account, args: Value, code: &str) -> Result<()> {
    let before = contract.view_state().await?;
    let result = caller
        .call(contract.id(), "propose_trade")
        .args_json(args)
        .transact()
        .await?;
    assert!(result.into_result().unwrap_err().to_string().contains(code));
    assert_eq!(contract.view_state().await?, before);
    Ok(())
}

#[tokio::test]
async fn public_proposals_validate_identity_wire_terms_and_preserve_assets() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    assert!(
        rex.call(contract.id(), "propose_trade")
            .args_json(args(1))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert!(contract.view_state().await?.is_empty());
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}
    })).transact().await?.into_result()?;
    let seed = market(&contract).await?;
    let now = seed["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    let expiry = now + 500_000_000_000;
    let args = args(expiry);
    for caller in [&owner, &luna, &bolt, &attacker, contract.as_account()] {
        rejected(&contract, caller, args.clone(), "BB:E_UNAUTHORIZED").await?;
    }
    let fixture = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/near/fixtures/storage_fixture.wasm"),
    )?;
    let proxy = worker.dev_deploy(&fixture).await?;
    let before = contract.view_state().await?;
    let forwarded = rex
        .call(proxy.id(), "forward_proposal")
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
    for (field, value, code) in [
        ("seller", "rex", "BB:E_INVALID_ROLES"),
        ("quantity", "0", "BB:E_INVALID_QUANTITY"),
        ("quantity", "101", "BB:E_INVALID_QUANTITY"),
        ("total_price", "0", "BB:E_INVALID_TOTAL"),
        ("total_price", "10001", "BB:E_INVALID_TOTAL"),
        ("total_price", "23", "BB:E_NON_INTEGER_UNIT_PRICE"),
        ("total_price", "404", "BB:E_INVALID_PRICE"),
        ("total_price", "184", "BB:E_INSUFFICIENT_GOLD"),
        ("quantity", "24", "BB:E_INSUFFICIENT_STOCK"),
        ("expires_at_ns", "0", "BB:E_INVALID_EXPIRY"),
        (
            "expires_at_ns",
            "18446744073709551615",
            "BB:E_INVALID_EXPIRY",
        ),
        ("action_id", "0", "BB:E_ACTION_USED"),
        ("action_id", "2", "BB:E_ACTION_GAP"),
    ] {
        let mut invalid = args.clone();
        invalid[field] = json!(value);
        rejected(&contract, &rex, invalid, code).await?;
    }
    let mut invalid = args.clone();
    invalid["proposer"] = json!("bolt");
    rejected(&contract, &bolt, invalid, "BB:E_INVALID_ROLES").await?;
    for field in [
        "proposer",
        "buyer",
        "seller",
        "resource",
        "quantity",
        "total_price",
        "expires_at_ns",
        "action_id",
    ] {
        let mut invalid = args.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            rex.call(contract.id(), "propose_trade")
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
        ("counterparty", json!("luna")),
        ("proposer", json!("other")),
        ("buyer", json!({"rex":null})),
        ("seller", json!(null)),
        ("resource", json!("gold")),
        ("quantity", json!(4)),
        ("quantity", json!("01")),
        ("quantity", json!("-1")),
        ("total_price", json!("1.5")),
        ("expires_at_ns", json!("18446744073709551616")),
        ("action_id", json!(true)),
    ] {
        let mut invalid = args.clone();
        invalid[field] = value;
        malformed.push(invalid);
    }
    for invalid in malformed {
        assert!(
            rex.call(contract.id(), "propose_trade")
                .args_json(invalid)
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(contract.view_state().await?, before);
    }
    let duplicate = serde_json::to_string(&args)?.replacen('{', "{\"action_id\":\"1\",", 1);
    assert!(
        rex.call(contract.id(), "propose_trade")
            .args(duplicate.into_bytes())
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(contract.view_state().await?, before);
    assert!(
        rex.call(contract.id(), "propose_trade")
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
    rejected(&contract, &rex, args.clone(), "BB:E_MARKET_PAUSED").await?;
    owner
        .call(contract.id(), "resume_market")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let success = rex
        .call(contract.id(), "propose_trade")
        .args(serde_json::to_vec_pretty(&args)?)
        .transact()
        .await?
        .into_result()?;
    println!("PROPOSAL gas={}", success.total_gas_burnt.as_gas());
    let receipt: Value = success.json()?;
    let offer = &receipt["data"]["offer"];
    assert_eq!(receipt["market_revision"], "4");
    assert_eq!(offer["offer_id"], "1");
    assert_eq!(offer["proposer"], "rex");
    assert_eq!(offer["buyer"], "rex");
    assert_eq!(offer["seller"], "luna");
    assert_eq!(offer["counterparty"], "luna");
    assert_eq!(offer["resource"], "crystal");
    assert_eq!(offer["quantity"], "4");
    assert_eq!(offer["unit_price"], "6");
    assert_eq!(offer["total_price"], "24");
    assert_eq!(offer["status"], "pending");
    assert_eq!(offer["expires_at_ns"], expiry.to_string());
    assert_eq!(offer["created_at_ns"], receipt["block_timestamp_ns"]);
    assert_eq!(offer["closed_at_ns"], Value::Null);
    assert_eq!(offer["settled_trade_id"], Value::Null);
    assert_eq!(
        offer["proposal_action"],
        json!({"merchant_id":"rex","action_id":"1"})
    );
    let action = &receipt["data"]["action"];
    let canonical = format!(
        r#"{{"args":{{"action_id":"1","buyer":"rex","expires_at_ns":"{expiry}","proposer":"rex","quantity":"4","resource":"crystal","seller":"luna","total_price":"24"}},"method":"propose_trade"}}"#
    );
    let digest: String = near_sdk::env::sha256_array(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(action["args_sha256"], digest);
    assert_eq!(action["offer_id"], "1");
    assert_eq!(action["method"], "propose_trade");
    let lookup: Value = contract
        .view("get_offer")
        .args_json(json!({"offer_id":"1"}))
        .await?
        .json()?;
    assert_eq!(lookup["data"]["offer"], *offer);
    rejected(&contract, &rex, args.clone(), "BB:E_ACTION_USED").await?;
    let mut next = args.clone();
    next["action_id"] = json!("3");
    rejected(&contract, &rex, next, "BB:E_ACTION_GAP").await?;
    let mut seller_proposal = args.clone();
    seller_proposal["proposer"] = json!("luna");
    let seller_receipt: Value = luna
        .call(contract.id(), "propose_trade")
        .args_json(seller_proposal)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(seller_receipt["data"]["offer"]["counterparty"], "rex");
    assert_eq!(seller_receipt["data"]["offer"]["offer_id"], "2");
    let mut bolt_proposal = args.clone();
    bolt_proposal["proposer"] = json!("bolt");
    bolt_proposal["buyer"] = json!("bolt");
    let bolt_receipt: Value = bolt
        .call(contract.id(), "propose_trade")
        .args_json(bolt_proposal)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(bolt_receipt["data"]["offer"]["offer_id"], "3");
    let after = market(&contract).await?;
    assert_eq!(after["data"]["next_offer_id"], "4");
    assert_eq!(after["data"]["next_trade_id"], "1");
    for index in 0..3 {
        for field in ["gold", "inventory", "listings"] {
            assert_eq!(
                after["data"]["merchants"][index][field],
                seed["data"]["merchants"][index][field]
            );
        }
        assert_eq!(after["data"]["merchants"][index]["last_action_id"], "1");
    }
    assert_eq!(after["data"]["merchants"][0]["last_action"], *action);
    for field in [
        "registered_player_count",
        "total_issued_gold",
        "resource_supply",
    ] {
        assert_eq!(after["data"][field], seed["data"][field]);
    }
    let pending:Value=contract.view("get_offers_for_merchant").args_json(json!({"merchant_id":"luna","status":"pending","after_id":null,"limit":"50","expected_revision":null})).await?.json()?;
    assert_eq!(pending["data"]["items"].as_array().unwrap().len(), 3);
    let history: Value = contract
        .view("get_recent_trades")
        .args_json(json!({"after_id":null,"limit":"50","expected_revision":null}))
        .await?
        .json()?;
    assert!(history["data"]["items"].as_array().unwrap().is_empty());
    let before = contract.view_state().await?;
    assert!(
        contract
            .call("forward_proposal")
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
async fn public_proposals_fill_all_pending_slots_and_cleanup_releases_capacity() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({
        "owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}
    })).transact().await?.into_result()?;
    let seed = market(&contract).await?;
    let expiry = seed["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?
        + 30_000_000_000;
    let mut last = None;
    for (proposer, buyer, seller, caller) in [
        ("rex", "rex", "luna", &rex),
        ("luna", "luna", "bolt", &luna),
        ("bolt", "bolt", "rex", &bolt),
    ] {
        for id in 1..=4 {
            let mut args = args(expiry);
            args["proposer"] = json!(proposer);
            args["buyer"] = json!(buyer);
            args["seller"] = json!(seller);
            args["action_id"] = json!(id.to_string());
            args["quantity"] = json!("1");
            args["total_price"] = json!("1");
            caller
                .call(contract.id(), "propose_trade")
                .args_json(args.clone())
                .transact()
                .await?
                .into_result()?;
            last = Some(args);
        }
    }
    let full = market(&contract).await?;
    assert_eq!(full["market_revision"], "13");
    assert_eq!(full["data"]["next_offer_id"], "13");
    let raw = contract.view_state().await?;
    let state: MarketState = borsh::from_slice(raw.get(b"STATE".as_slice()).unwrap())?;
    assert_eq!(state.pending_offer_ids.iter().flatten().count(), 12);
    assert!(state.merchants.iter().all(|m| m.pending_offer_count == 8));
    let mut extra = last.unwrap();
    extra["action_id"] = json!("5");
    rejected(&contract, &bolt, extra.clone(), "BB:E_OFFER_CAPACITY").await?;
    worker.fast_forward(400).await?;
    let current = market(&contract).await?;
    let now = current["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    assert!(
        now >= expiry,
        "sandbox time {now} did not reach expiry {expiry}"
    );
    extra["expires_at_ns"] = json!((now + 30_000_000_000).to_string());
    rejected(&contract, &bolt, extra.clone(), "BB:E_OFFER_CAPACITY").await?;
    let before_expired_acceptance = contract.view_state().await?;
    let expired = rex
        .call(contract.id(), "accept_trade")
        .args_json(json!({"offer_id":"9","action_id":"5"}))
        .transact()
        .await?;
    assert!(
        expired
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_OFFER_EXPIRED")
    );
    assert_eq!(contract.view_state().await?, before_expired_acceptance);
    let expired_cancellation = bolt
        .call(contract.id(), "cancel_trade")
        .args_json(json!({"offer_id":"9","action_id":"5"}))
        .transact()
        .await?;
    assert!(
        expired_cancellation
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_OFFER_EXPIRED")
    );
    assert_eq!(contract.view_state().await?, before_expired_acceptance);
    let cleanup: Value = rex
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":["9"]}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(cleanup["data"]["expired_offer_ids"], json!(["9"]));
    let after_cleanup = contract.view_state().await?;
    let expired = rex
        .call(contract.id(), "accept_trade")
        .args_json(json!({"offer_id":"9","action_id":"5"}))
        .transact()
        .await?;
    assert!(
        expired
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_OFFER_EXPIRED")
    );
    assert_eq!(contract.view_state().await?, after_cleanup);
    let expired_cancellation = bolt
        .call(contract.id(), "cancel_trade")
        .args_json(json!({"offer_id":"9","action_id":"5"}))
        .transact()
        .await?;
    assert!(
        expired_cancellation
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_OFFER_EXPIRED")
    );
    assert_eq!(contract.view_state().await?, after_cleanup);
    let created: Value = bolt
        .call(contract.id(), "propose_trade")
        .args_json(extra)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(created["data"]["offer"]["offer_id"], "13");
    assert_eq!(created["data"]["action"]["action_id"], "5");
    assert_eq!(created["market_revision"], "15");
    let after = market(&contract).await?;
    for index in 0..3 {
        for field in ["gold", "inventory", "listings"] {
            assert_eq!(
                after["data"]["merchants"][index][field],
                seed["data"]["merchants"][index][field]
            );
        }
    }
    println!("PROPOSAL_CAPACITY pending=12 per_merchant=8 cleanup_released=1 next_offer_id=14");
    // Exercise maximum useful cleanup work: all 12 pending offers expire,
    // while the rest of the 24-ID request is terminal or nonexistent.
    worker.fast_forward(400).await?;
    let now = market(&contract).await?["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    assert!(
        now >= created["data"]["offer"]["expires_at_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
    );
    let cleanup = rex
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":(1..=24).map(|id|id.to_string()).collect::<Vec<_>>()}))
        .gas(near_workspaces::types::Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    let gas = cleanup.total_gas_burnt.as_gas();
    let result: Value = cleanup.json()?;
    assert_eq!(
        result["data"]["expired_offer_ids"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
    assert_eq!(
        result["data"]["ignored_offer_ids"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
    assert_eq!(result["market_revision"], "16");
    let raw = contract.view_state().await?;
    let state: MarketState = borsh::from_slice(raw.get(b"STATE".as_slice()).unwrap())?;
    assert!(state.pending_offer_ids.iter().all(Option::is_none));
    assert!(
        state
            .merchants
            .iter()
            .all(|merchant| merchant.pending_offer_count == 0)
    );
    let repeated = rex
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":(1..=24).map(|id|id.to_string()).collect::<Vec<_>>()}))
        .gas(near_workspaces::types::Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    assert!(repeated.logs().is_empty());
    assert_eq!(contract.view_state().await?, raw);
    assert!(gas < 30_000_000_000_000);
    println!("LIMIT_CLEANUP input=24 expired=12 ignored=12 gas={gas}");
    Ok(())
}
