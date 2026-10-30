use super::wasm;
use anyhow::Result;
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, PartialEq)]
struct GameSnapshot {
    public: Value,
    storage: BTreeMap<Vec<u8>, Vec<u8>>,
}

async fn snapshot(contract: &Contract, accounts: &[&Account]) -> Result<GameSnapshot> {
    let market: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    let revision = market["market_revision"].clone();
    let mut players = serde_json::Map::new();
    for account in accounts {
        let player: Value = contract
            .view("get_player")
            .args_json(json!({"account_id":account.id()}))
            .await?
            .json()?;
        assert_eq!(player["market_revision"], revision);
        players.insert(account.id().to_string(), player["data"].clone());
    }
    let mut offers = serde_json::Map::new();
    for merchant in ["rex", "luna", "bolt"] {
        let page:Value=contract.view("get_offers_for_merchant").args_json(json!({"merchant_id":merchant,"status":"all","after_id":null,"limit":"50","expected_revision":revision})).await?.json()?;
        assert!(!page["data"]["has_more"].as_bool().unwrap());
        offers.insert(merchant.to_owned(), page["data"].clone());
    }
    let trades: Value = contract
        .view("get_recent_trades")
        .args_json(json!({"after_id":null,"limit":"50","expected_revision":revision}))
        .await?
        .json()?;
    assert!(!trades["data"]["has_more"].as_bool().unwrap());
    Ok(GameSnapshot {
        public: json!({"revision":revision,"market":market["data"],"players":players,"offers":offers,"trades":trades["data"]}),
        storage: contract.view_state().await?.into_iter().collect(),
    })
}

pub(super) async fn reject(
    contract: &Contract,
    accounts: &[&Account],
    caller: &Account,
    method: &str,
    args: Value,
    code: &str,
) -> Result<()> {
    let before = snapshot(contract, accounts).await?;
    let result = caller
        .call(contract.id(), method)
        .args_json(args)
        .transact()
        .await?;
    assert!(
        result.is_failure(),
        "{method} unexpectedly succeeded for {}",
        caller.id()
    );
    assert!(
        !result
            .logs()
            .iter()
            .any(|log| log.starts_with("EVENT_JSON:"))
    );
    assert!(
        result.into_result().unwrap_err().to_string().contains(code),
        "wrong rejection for {method}"
    );
    assert_eq!(
        snapshot(contract, accounts).await?,
        before,
        "{method} rejection changed game state"
    );
    Ok(())
}

async fn call(contract: &Contract, caller: &Account, method: &str, args: Value) -> Result<Value> {
    let success = caller
        .call(contract.id(), method)
        .args_json(args)
        .transact()
        .await?
        .into_result()?;
    let result: Value = success.json()?;
    super::events::assert_event(&success, method, caller.id().as_str(), &result)?;
    Ok(result)
}

fn proposal(proposer: &str, action: u64, expiry: u64) -> Value {
    json!({"proposer":proposer,"buyer":"rex","seller":"luna","resource":"crystal","quantity":"4","total_price":"24","expires_at_ns":expiry.to_string(),"action_id":action.to_string()})
}

#[tokio::test]
async fn distinct_account_roles_preserve_all_public_assets_and_storage_after_rejections()
-> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let accounts = [
        &owner,
        &player,
        &attacker,
        &rex,
        &luna,
        &bolt,
        contract.as_account(),
    ];
    assert_eq!(
        accounts
            .iter()
            .map(|account| account.id())
            .collect::<BTreeSet<_>>()
            .len(),
        7
    );
    contract.call("initialize_market").args_json(json!({"owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}})).transact().await?.into_result()?;
    call(&contract, &player, "register_player", json!({})).await?;
    for caller in [&owner, &rex, &luna] {
        reject(
            &contract,
            &accounts,
            caller,
            "register_player",
            json!({}),
            "BB:E_RESERVED_ACCOUNT",
        )
        .await?;
    }
    reject(
        &contract,
        &accounts,
        &player,
        "register_player",
        json!({}),
        "BB:E_ALREADY_REGISTERED",
    )
    .await?;
    let buy = json!({"merchant_id":"rex","resource":"crystal","quantity":"12","max_total_price":"48","listing_version":"1"});
    reject(
        &contract,
        &accounts,
        &attacker,
        "buy_from_merchant",
        buy.clone(),
        "BB:E_NOT_REGISTERED",
    )
    .await?;
    let listing = json!({"merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"2","active":true,"expected_version":"1","action_id":"1"});
    reject(
        &contract,
        &accounts,
        &owner,
        "set_listing",
        listing.clone(),
        "BB:E_UNAUTHORIZED",
    )
    .await?;
    reject(
        &contract,
        &accounts,
        &attacker,
        "pause_market",
        json!({}),
        "BB:E_UNAUTHORIZED",
    )
    .await?;
    let seed: Value = contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?;
    let expiry = seed["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?
        + 500_000_000_000;
    reject(
        &contract,
        &accounts,
        &player,
        "propose_trade",
        proposal("rex", 1, expiry),
        "BB:E_UNAUTHORIZED",
    )
    .await?;
    call(&contract, &player, "buy_from_merchant", buy.clone()).await?;
    reject(
        &contract,
        &accounts,
        &player,
        "buy_from_merchant",
        buy,
        "BB:E_STALE_LISTING",
    )
    .await?;
    let first = call(&contract, &rex, "propose_trade", proposal("rex", 1, expiry)).await?;
    assert_eq!(first["data"]["offer"]["offer_id"], "1");
    for caller in [&rex, &attacker] {
        reject(
            &contract,
            &accounts,
            caller,
            "accept_trade",
            json!({"offer_id":"1","action_id":"1"}),
            "BB:E_UNAUTHORIZED",
        )
        .await?;
    }
    reject(
        &contract,
        &accounts,
        &luna,
        "cancel_trade",
        json!({"offer_id":"1","action_id":"2"}),
        "BB:E_UNAUTHORIZED",
    )
    .await?;
    reject(
        &contract,
        &accounts,
        &rex,
        "propose_trade",
        proposal("rex", 1, expiry),
        "BB:E_ACTION_USED",
    )
    .await?;
    reject(
        &contract,
        &accounts,
        &rex,
        "propose_trade",
        proposal("rex", 3, expiry),
        "BB:E_ACTION_GAP",
    )
    .await?;
    call(&contract, &owner, "pause_market", json!({})).await?;
    let mut current_listing = listing;
    current_listing["expected_version"] = json!("2");
    current_listing["action_id"] = json!("2");
    for (caller, method, args) in [
        (&attacker, "register_player", json!({})),
        (
            &player,
            "buy_from_merchant",
            json!({"merchant_id":"rex","resource":"crystal","quantity":"1","max_total_price":"4","listing_version":"2"}),
        ),
        (&rex, "set_listing", current_listing),
        (&luna, "propose_trade", proposal("luna", 1, expiry)),
        (
            &luna,
            "accept_trade",
            json!({"offer_id":"1","action_id":"1"}),
        ),
    ] {
        reject(
            &contract,
            &accounts,
            caller,
            method,
            args,
            "BB:E_MARKET_PAUSED",
        )
        .await?;
    }
    let cancelled = call(
        &contract,
        &rex,
        "cancel_trade",
        json!({"offer_id":"1","action_id":"2"}),
    )
    .await?;
    assert_eq!(cancelled["data"]["offer"]["status"], "cancelled");
    let before_cleanup = snapshot(&contract, &accounts).await?;
    let ignored: Value = attacker
        .call(contract.id(), "expire_offers")
        .args_json(json!({"offer_ids":["1"]}))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(ignored["data"]["ignored_offer_ids"], json!(["1"]));
    assert_eq!(snapshot(&contract, &accounts).await?, before_cleanup);
    call(&contract, &owner, "resume_market", json!({})).await?;
    reject(
        &contract,
        &accounts,
        &luna,
        "accept_trade",
        json!({"offer_id":"1","action_id":"1"}),
        "BB:E_OFFER_CANCELLED",
    )
    .await?;
    let next = call(&contract, &rex, "propose_trade", proposal("rex", 3, expiry)).await?;
    assert_eq!(next["data"]["offer"]["offer_id"], "2");
    call(
        &contract,
        &luna,
        "accept_trade",
        json!({"offer_id":"2","action_id":"1"}),
    )
    .await?;
    reject(
        &contract,
        &accounts,
        &luna,
        "accept_trade",
        json!({"offer_id":"2","action_id":"2"}),
        "BB:E_OFFER_ACCEPTED",
    )
    .await?;
    reject(
        &contract,
        &accounts,
        &rex,
        "cancel_trade",
        json!({"offer_id":"2","action_id":"4"}),
        "BB:E_OFFER_ACCEPTED",
    )
    .await?;
    let final_state = snapshot(&contract, &accounts).await?;
    let public = &final_state.public;
    assert_eq!(public["revision"], "9");
    assert_eq!(public["market"]["registered_player_count"], "1");
    assert_eq!(public["players"][player.id().as_str()]["gold"], "52");
    assert_eq!(
        public["players"][player.id().as_str()]["inventory"]["crystal"],
        "12"
    );
    for account in [&owner, &attacker, &rex, &luna, &bolt, contract.as_account()] {
        assert_eq!(public["players"][account.id().as_str()], Value::Null);
    }
    for (index, gold, crystals, action) in [
        (0, "204", "7", "3"),
        (1, "244", "8", "1"),
        (2, "150", "2", "0"),
    ] {
        assert_eq!(public["market"]["merchants"][index]["gold"], gold);
        assert_eq!(
            public["market"]["merchants"][index]["inventory"]["crystal"],
            crystals
        );
        assert_eq!(
            public["market"]["merchants"][index]["last_action_id"],
            action
        );
    }
    assert_eq!(public["offers"]["rex"]["items"][0]["status"], "cancelled");
    assert_eq!(public["offers"]["rex"]["items"][1]["status"], "accepted");
    assert_eq!(public["trades"]["items"].as_array().unwrap().len(), 2);
    println!(
        "SANDBOX_ROLES distinct_accounts=7 rejected_calls=22 snapshots=public_and_raw final_revision=9"
    );
    Ok(())
}
