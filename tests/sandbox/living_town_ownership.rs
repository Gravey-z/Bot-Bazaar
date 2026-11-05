use super::{canonical, wasm};
use anyhow::Result;
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}
async fn command(contract: &Contract, sequence: u64) -> Result<Value> {
    let town = view(contract, "get_town", json!({})).await?;
    let now = town["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    Ok(
        json!({"sequence":sequence.to_string(),"config_version":"1","valid_until_ns":(now+500_000_000_000).to_string()}),
    )
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
        .await?
        .into_result();
    assert!(
        result.unwrap_err().to_string().contains(code),
        "expected {code}"
    );
    assert_eq!(
        contract.view_state().await?,
        before,
        "failed {method} changed stored state"
    );
    Ok(())
}
#[tokio::test]
async fn ownership_grants_races_replays_and_owner_only_rename() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    let other = worker.dev_create_account().await?;
    contract.call("initialize_town").args_json(json!({"owner_account_id":owner.id(),"operator_account_id":operator.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    for caller in [contract.as_account(), &owner, &operator, &rex, &luna, &bolt] {
        reject(
            &contract,
            caller,
            "register_player",
            json!({"command":command(&contract,1).await?}),
            "LT:E_RESERVED_ACCOUNT",
        )
        .await?;
    }
    assert!(
        view(&contract, "get_player", json!({"account_id":player.id()})).await?["data"].is_null()
    );
    reject(
        &contract,
        &player,
        "create_shop",
        json!({"name":"Before Register","command":command(&contract,1).await?}),
        "LT:E_NOT_REGISTERED",
    )
    .await?;
    let register = json!({"command":command(&contract,1).await?});
    let (a, b) = tokio::join!(
        player
            .call(contract.id(), "register_player")
            .args_json(register.clone())
            .transact(),
        player
            .call(contract.id(), "register_player")
            .args_json(register.clone())
            .transact()
    );
    let mut applied = 0;
    let mut raced_successes = 0;
    for result in [a, b] {
        if let Ok(result) = result
            && let Ok(success) = result.into_result()
        {
            raced_successes += 1;
            let value: Value = success.json()?;
            if value["data"]["replayed"] == false {
                applied += 1;
                assert_eq!(success.logs().len(), 1);
            } else {
                assert!(success.logs().is_empty());
            }
        }
    }
    assert!(raced_successes >= 1);
    assert_eq!(applied, 1);
    let stored = contract.view_state().await?;
    let replay = player
        .call(contract.id(), "register_player")
        .args_json(register.clone())
        .transact()
        .await?
        .into_result()?;
    assert!(replay.logs().is_empty());
    let replay: Value = replay.json()?;
    assert_eq!(replay["data"]["replayed"], true);
    assert_eq!(contract.view_state().await?, stored);
    let registered = view(&contract, "get_player", json!({"account_id":player.id()})).await?;
    assert_eq!(registered["data"]["ledger"]["gold"]["held"], "100");
    assert!(registered["data"]["shop_id"].is_null());
    assert!(
        registered["data"]["ledger"]["inventory"]["held"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == "0")
    );
    reject(
        &contract,
        &player,
        "register_player",
        json!({"command":command(&contract,2).await?}),
        "LT:E_ALREADY_REGISTERED",
    )
    .await?;
    let mut conflict = register.clone();
    conflict["command"]["valid_until_ns"] = json!(
        (register["command"]["valid_until_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 1)
        .to_string()
    );
    reject(
        &contract,
        &player,
        "register_player",
        conflict,
        "LT:E_COMMAND_CONFLICT",
    )
    .await?;
    reject(
        &contract,
        &player,
        "create_shop",
        json!({"name":"Gap","command":command(&contract,3).await?}),
        "LT:E_COMMAND_GAP",
    )
    .await?;
    for name in [
        "".to_owned(),
        "x".repeat(33),
        "é".to_owned(),
        "<tag>".to_owned(),
        " bad".to_owned(),
    ] {
        reject(
            &contract,
            &player,
            "create_shop",
            json!({"name":name,"command":command(&contract,2).await?}),
            "LT:E_INVALID_ARGUMENT",
        )
        .await?;
    }
    let create = json!({"name":"First Shop","command":command(&contract,2).await?});
    let rival = json!({"name":"Other Tab","command":create["command"]});
    let (a, b) = tokio::join!(
        player
            .call(contract.id(), "create_shop")
            .args_json(create.clone())
            .transact(),
        player
            .call(contract.id(), "create_shop")
            .args_json(rival.clone())
            .transact()
    );
    let mut winner = None;
    for result in [a, b] {
        if let Ok(result) = result
            && let Ok(success) = result.into_result()
        {
            let value: Value = success.json()?;
            assert_eq!(value["data"]["replayed"], false);
            assert!(winner.is_none());
            winner = Some(value);
        }
    }
    let created = winner.expect("one creation won");
    let shop = &created["data"]["outcome"]["shop"];
    assert_eq!(shop["shop_id"], "4");
    let winning_name = shop["name"].as_str().unwrap();
    let (winning, losing) = if winning_name == "First Shop" {
        (create.clone(), rival)
    } else {
        (rival, create.clone())
    };
    let cached = player
        .call(contract.id(), "create_shop")
        .args_json(winning)
        .transact()
        .await?
        .into_result()?;
    assert!(cached.logs().is_empty());
    reject(
        &contract,
        &player,
        "create_shop",
        losing,
        "LT:E_COMMAND_CONFLICT",
    )
    .await?;
    reject(
        &contract,
        &player,
        "create_shop",
        json!({"name":"Duplicate","command":command(&contract,3).await?}),
        "LT:E_SHOP_EXISTS",
    )
    .await?;
    reject(
        &contract,
        &player,
        "register_player",
        register,
        "LT:E_COMMAND_PRUNED",
    )
    .await?;
    let after = view(&contract, "get_player", json!({"account_id":player.id()})).await?;
    assert_eq!(after["data"]["ledger"], registered["data"]["ledger"]);
    assert_eq!(after["data"]["shop_id"], "4");
    let town = view(&contract, "get_town", json!({})).await?;
    assert_eq!(town["data"]["registered_player_count"], "1");
    assert_eq!(town["data"]["totals"]["player_grants"], "100");
    assert_eq!(town["data"]["next_shop_id"], "5");
    let rename = json!({"shop_id":"4","expected_shop_revision":"1","name":"Renamed Shop","command":command(&contract,3).await?});
    reject(
        &contract,
        &other,
        "rename_shop",
        rename.clone(),
        "LT:E_NOT_OWNER",
    )
    .await?;
    for (field, value) in [
        ("shop_id", json!("1")),
        ("owner_account_id", json!(other.id())),
    ] {
        let mut bad = rename.clone();
        bad[field] = value;
        reject(
            &contract,
            &player,
            "rename_shop",
            bad,
            "LT:E_INVALID_ARGUMENT",
        )
        .await?;
    }
    let mut stale = rename.clone();
    stale["expected_shop_revision"] = json!("2");
    reject(&contract, &player, "rename_shop", stale, "LT:E_STALE_SHOP").await?;
    let renamed = player
        .call(contract.id(), "rename_shop")
        .args_json(rename.clone())
        .transact()
        .await?
        .into_result()?;
    assert_eq!(renamed.logs().len(), 1);
    let renamed: Value = renamed.json()?;
    assert_eq!(renamed["data"]["outcome"]["shop"]["revision"], "2");
    let cached = player
        .call(contract.id(), "rename_shop")
        .args_json(rename)
        .transact()
        .await?
        .into_result()?;
    assert!(cached.logs().is_empty());
    let shop = view(&contract, "get_shop", json!({"shop_id":"4"})).await?;
    assert_eq!(shop["data"]["name"], "Renamed Shop");
    let revision = shop["market_revision"].clone();
    let page=view(&contract,"get_player_shops",json!({"account_id":player.id(),"after_id":null,"limit":"50","expected_market_revision":revision})).await?;
    assert_eq!(page["data"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"]["items"][0], shop["data"]);
    let empty=view(&contract,"get_player_shops",json!({"account_id":player.id(),"after_id":"4","limit":"1","expected_market_revision":revision})).await?;
    assert_eq!(empty["data"]["items"], json!([]));
    assert!(contract.view("get_player_shops").args_json(json!({"account_id":player.id(),"after_id":null,"limit":"0","expected_market_revision":revision})).await.is_err());
    assert!(contract.view("get_player_shops").args_json(json!({"account_id":player.id(),"after_id":null,"limit":"1","expected_market_revision":"1"})).await.is_err());
    let result = view(
        &contract,
        "get_command",
        json!({"principal":format!("account:{}",player.id()),"sequence":"1"}),
    )
    .await?;
    assert_eq!(result["data"]["kind"], "pruned");
    assert_eq!(result["data"]["high_water"], "3");
    let result = view(
        &contract,
        "get_command",
        json!({"principal":format!("account:{}",player.id()),"sequence":"3"}),
    )
    .await?;
    assert_eq!(result["data"]["kind"], "found");
    let result = view(
        &contract,
        "get_command",
        json!({"principal":format!("account:{}",player.id()),"sequence":"4"}),
    )
    .await?;
    assert_eq!(result["data"]["kind"], "not_applied");
    assert_eq!(result["data"]["next_sequence"], "4");
    // A different owner obtains its own grant/ID, not the first owner's shop or ledger.
    other
        .call(contract.id(), "register_player")
        .args_json(json!({"command":command(&contract,1).await?}))
        .transact()
        .await?
        .into_result()?;
    other
        .call(contract.id(), "create_shop")
        .args_json(json!({"name":"Independent","command":command(&contract,2).await?}))
        .transact()
        .await?
        .into_result()?;
    let second = view(&contract, "get_player", json!({"account_id":other.id()})).await?;
    assert_eq!(second["data"]["shop_id"], "5");
    assert_eq!(second["data"]["ledger"]["gold"]["held"], "100");
    // Keep native storage stake but remove the extra 25% admission headroom.
    // This reaches the guard AFTER buffered map/root writes and must revert them.
    let account = contract.view_account().await?;
    let byte_cost = near_sdk::env::storage_byte_cost().as_yoctonear();
    let keep = u128::from(account.storage_usage) * byte_cost * 11 / 10;
    contract
        .as_account()
        .transfer_near(
            other.id(),
            near_workspaces::types::NearToken::from_yoctonear(
                account.balance.as_yoctonear() - keep,
            ),
        )
        .await?
        .into_result()?;
    let third = worker.dev_create_account().await?;
    let pending = json!({"command":command(&contract,1).await?});
    reject(
        &contract,
        &third,
        "register_player",
        pending.clone(),
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    assert!(
        view(&contract, "get_player", json!({"account_id":third.id()})).await?["data"].is_null()
    );
    let unknown = view(
        &contract,
        "get_command",
        json!({"principal":format!("account:{}",third.id()),"sequence":"1"}),
    )
    .await?;
    assert_eq!(unknown["data"]["high_water"], "0");
    other
        .transfer_near(
            contract.id(),
            near_workspaces::types::NearToken::from_near(1),
        )
        .await?
        .into_result()?;
    let recovered: Value = third
        .call(contract.id(), "register_player")
        .args_json(pending)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        recovered["data"]["outcome"]["player"]["ledger"]["gold"]["held"],
        "100"
    );
    println!(
        "OWNERSHIP_PLAYER={}",
        view(&contract, "get_player", json!({"account_id":player.id()})).await?
    );
    println!("OWNERSHIP_SHOP={shop}");
    println!("OWNERSHIP_EFFECT={created}");
    println!(
        "OWNERSHIP_RACE registration_successes={raced_successes} grants_applied={applied} shops_for_first_owner=1 gold=100"
    );
    Ok(())
}
