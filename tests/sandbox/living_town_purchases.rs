use super::{canonical, wasm};
use anyhow::Result;
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

async fn view(c: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(c.view(method).args_json(args).await?.json()?)
}
async fn command(c: &Contract, seq: u64) -> Result<Value> {
    let t = view(c, "get_town", json!({})).await?;
    Ok(
        json!({"sequence":seq.to_string(),"config_version":"1","valid_until_ns":(t["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?+500_000_000_000).to_string()}),
    )
}
async fn buy(
    c: &Contract,
    seq: u64,
    merchant: &str,
    item: &str,
    q: &str,
    rev: &str,
    cap: &str,
) -> Result<Value> {
    Ok(
        json!({"merchant_id":merchant,"item_id":item,"quantity":q,"expected_listing_revision":rev,"max_total_price":cap,"command":command(c,seq).await?}),
    )
}
async fn reject(c: &Contract, a: &Account, args: Value, code: &str) -> Result<()> {
    let before = c.view_state().await?;
    let r = a
        .call(c.id(), "buy_from_merchant")
        .args_json(args)
        .transact()
        .await?
        .into_result();
    assert!(r.unwrap_err().to_string().contains(code), "expected {code}");
    assert_eq!(c.view_state().await?, before, "rejection changed state");
    Ok(())
}
async fn register(c: &Contract, a: &Account) -> Result<()> {
    a.call(c.id(), "register_player")
        .args_json(json!({"command":command(c,1).await?}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}
#[tokio::test]
async fn materials_settle_once_conserve_assets_and_acquire_both_recipe_inputs() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    let player = worker.dev_create_account().await?;
    reject(
        &c,
        &player,
        buy(&c, 1, "rex", "crystal", "1", "1", "4").await?,
        "LT:E_NOT_REGISTERED",
    )
    .await?;
    register(&c, &player).await?;
    player
        .call(c.id(), "create_shop")
        .args_json(json!({"name":"Materials","command":command(&c,2).await?}))
        .transact()
        .await?
        .into_result()?;
    for (field, value, code) in [
        ("quantity", json!("0"), "LT:E_INVALID_QUANTITY"),
        ("quantity", json!("101"), "LT:E_INVALID_QUANTITY"),
        (
            "quantity",
            json!("18446744073709551615"),
            "LT:E_INVALID_QUANTITY",
        ),
        ("item_id", json!("health_potion"), "LT:E_INVALID_ARGUMENT"),
        ("item_id", json!("iron_tool"), "LT:E_INVALID_ARGUMENT"),
        ("merchant_id", json!("luna"), "LT:E_INVALID_ARGUMENT"),
        (
            "expected_listing_revision",
            json!("2"),
            "LT:E_STALE_LISTING",
        ),
        ("max_total_price", json!("3"), "LT:E_MAX_TOTAL"),
        ("max_total_price", json!("10001"), "LT:E_MAX_TOTAL"),
        ("buyer", json!("victim.testnet"), "LT:E_INVALID_ARGUMENT"),
    ] {
        let mut args = buy(&c, 3, "rex", "crystal", "1", "1", "4").await?;
        args[field] = value;
        reject(&c, &player, args, code).await?;
    }
    for (field, value, code) in [
        ("config_version", "2", "LT:E_CONFIG_CHANGED"),
        ("valid_until_ns", "1", "LT:E_COMMAND_EXPIRED"),
        ("sequence", "4", "LT:E_COMMAND_GAP"),
    ] {
        let mut args = buy(&c, 3, "rex", "crystal", "1", "1", "4").await?;
        args["command"][field] = json!(value);
        reject(&c, &player, args, code).await?;
    }
    let mut first_args = Value::Null;
    let mut first_effect = Value::Null;
    for (i, (merchant, item, q, cap)) in [
        ("rex", "crystal", "1", "4"),
        ("bolt", "wood", "1", "2"),
        ("luna", "herb", "2", "6"),
        ("bolt", "iron", "2", "10"),
    ]
    .iter()
    .enumerate()
    {
        let args = buy(&c, i as u64 + 3, merchant, item, q, "1", cap).await?;
        let receipt = player
            .call(c.id(), "buy_from_merchant")
            .args_json(args.clone())
            .transact()
            .await?
            .into_result()?;
        assert_eq!(receipt.logs().len(), 1);
        let event: Value =
            serde_json::from_str(receipt.logs()[0].strip_prefix("EVENT_JSON:").unwrap())?;
        let effect: Value = receipt.json()?;
        assert_eq!(event["event"], "buy_from_merchant");
        assert_eq!(event["data"][0]["outcome"], effect["data"]["outcome"]);
        assert_eq!(
            effect["data"]["outcome"]["trade"]["trade_id"],
            (i + 1).to_string()
        );
        let before = c.view_state().await?;
        let retry = player
            .call(c.id(), "buy_from_merchant")
            .args_json(args.clone())
            .transact()
            .await?
            .into_result()?;
        assert!(retry.logs().is_empty());
        let replay: Value = retry.json()?;
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(replay["data"]["outcome"], effect["data"]["outcome"]);
        assert_eq!(c.view_state().await?, before);
        let mut conflict = args.clone();
        conflict["max_total_price"] = json!("100");
        reject(&c, &player, conflict, "LT:E_COMMAND_CONFLICT").await?;
        if i == 0 {
            first_args = args;
            first_effect = effect;
        }
    }
    let p = view(&c, "get_player", json!({"account_id":player.id()})).await?;
    assert_eq!(p["data"]["ledger"]["gold"]["held"], "78");
    assert_eq!(
        p["data"]["ledger"]["inventory"]["held"],
        json!({"crystal":"1","wood":"1","herb":"2","iron":"2","health_potion":"0","iron_tool":"0"})
    );
    let town = view(&c, "get_town", json!({})).await?;
    assert_eq!(town["data"]["totals"]["player_grants"], "100");
    assert_eq!(town["data"]["next_trade_id"], "5");
    let npc_gold: u64 = town["data"]["npc_ledgers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["gold"]["held"].as_str().unwrap().parse::<u64>().unwrap())
        .sum();
    assert_eq!(npc_gold + 78 + 100, 800); // NPC + player + customer pool; one grant only.
    for (item, seed) in [("crystal", 10), ("wood", 10), ("herb", 20), ("iron", 20)] {
        let npc_total: u64 = town["data"]["npc_ledgers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| {
                l["inventory"]["held"][item]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
            })
            .sum();
        let player_amount = p["data"]["ledger"]["inventory"]["held"][item]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        assert_eq!(npc_total + player_amount, seed);
    }
    for (i, amounts) in [
        (0, ["9", "7", "2"]),
        (1, ["18", "10", "8"]),
        (2, ["9", "7", "2"]),
    ] {
        let item = if i == 0 {
            "crystal"
        } else if i == 1 {
            "herb"
        } else {
            "wood"
        };
        let inv = &town["data"]["npc_ledgers"][i]["inventory"];
        for (key, value) in ["held", "listing_reserved", "available"]
            .iter()
            .zip(amounts)
        {
            assert_eq!(inv[key][item], value);
        }
    }
    assert_eq!(
        view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?["data"],
        p["data"]["ledger"]
    );
    reject(&c, &player, first_args, "LT:E_COMMAND_PRUNED").await?;
    let lookup = view(
        &c,
        "get_command",
        json!({"principal":format!("account:{}",player.id()),"sequence":"6"}),
    )
    .await?;
    assert_eq!(lookup["data"]["kind"], "found");
    assert_eq!(lookup["data"]["method"], "buy_from_merchant");
    assert_eq!(
        view(&c, "get_trade", json!({"trade_id":"1"})).await?["data"]["value"],
        first_effect["data"]["outcome"]["trade"]
    );
    assert_eq!(
        view(&c, "get_trade", json!({"trade_id":"5"})).await?["data"]["kind"],
        "not_found"
    );
    let list_args = json!({"shop_id":null,"item_id":null,"active_only":true,"after_id":null,"limit":"2","expected_market_revision":town["market_revision"]});
    let page = view(&c, "get_listings", list_args.clone()).await?;
    assert_eq!(page["data"]["has_more"], true);
    assert_eq!(page["data"]["items"][0]["listing_id"], "1");
    assert_eq!(page["data"]["items"][1]["listing_id"], "2");
    let mut next = list_args.clone();
    next["after_id"] = page["data"]["next_after_id"].clone();
    assert_eq!(
        view(&c, "get_listings", next).await?["data"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let mut stale = list_args.clone();
    stale["expected_market_revision"] = json!("1");
    assert!(c.view("get_listings").args_json(stale).await.is_err());
    let mut oversized = list_args;
    oversized["limit"] = json!("51");
    assert!(c.view("get_listings").args_json(oversized).await.is_err());
    println!("PURCHASE_PLAYER={p}");
    println!("PURCHASE_TOWN={town}");
    println!("PURCHASE_EFFECT={first_effect}");
    println!("PURCHASE_LISTINGS={page}");
    println!("PURCHASE_COMMAND={lookup}");
    // Oversized listed purchase, then balance failure, then full depletion to the floor.
    reject(
        &c,
        &player,
        buy(&c, 7, "rex", "crystal", "8", "2", "32").await?,
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    player
        .call(c.id(), "buy_from_merchant")
        .args_json(buy(&c, 7, "luna", "herb", "10", "2", "30").await?)
        .transact()
        .await?
        .into_result()?;
    reject(
        &c,
        &player,
        buy(&c, 8, "bolt", "iron", "14", "2", "70").await?,
        "LT:E_INSUFFICIENT_GOLD",
    )
    .await?;
    player
        .call(c.id(), "buy_from_merchant")
        .args_json(buy(&c, 8, "rex", "crystal", "7", "2", "28").await?)
        .transact()
        .await?
        .into_result()?;
    reject(
        &c,
        &player,
        buy(&c, 9, "rex", "crystal", "1", "3", "4").await?,
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    // Independent buyers race for the same remaining listing and reviewed revision.
    let a = worker.dev_create_account().await?;
    let b = worker.dev_create_account().await?;
    register(&c, &a).await?;
    register(&c, &b).await?;
    let args = buy(&c, 2, "bolt", "wood", "7", "2", "14").await?;
    let (r1, r2) = tokio::join!(
        a.call(c.id(), "buy_from_merchant")
            .args_json(args.clone())
            .transact(),
        b.call(c.id(), "buy_from_merchant")
            .args_json(args)
            .transact()
    );
    let results = [r1?.into_result(), r2?.into_result()];
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| e.to_string().contains("LT:E_STALE_LISTING"))
    );
    let end = view(&c, "get_town", json!({})).await?;
    assert_eq!(
        end["data"]["npc_ledgers"][2]["inventory"]["held"]["wood"],
        "2"
    );
    assert_eq!(
        end["data"]["npc_ledgers"][2]["inventory"]["listing_reserved"]["wood"],
        "0"
    );
    println!(
        "PURCHASE_PROOF recipe_inputs=[1,1,2,2] cost=22 crafting=false race_successes=1 no_oversell=true"
    );
    // Also prove the post-write funding guard rolls back the economic transfer,
    // trade allocation/history, command result, and both ledger revisions.
    let storage_player = worker.dev_create_account().await?;
    register(&c, &storage_player).await?;
    let pending = buy(&c, 2, "bolt", "iron", "1", "2", "5").await?;
    let native = c.view_account().await?;
    let keep =
        u128::from(native.storage_usage) * near_sdk::env::storage_byte_cost().as_yoctonear() * 11
            / 10;
    c.as_account()
        .transfer_near(
            storage_player.id(),
            near_workspaces::types::NearToken::from_yoctonear(native.balance.as_yoctonear() - keep),
        )
        .await?
        .into_result()?;
    reject(
        &c,
        &storage_player,
        pending.clone(),
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    let unchanged = view(
        &c,
        "get_command",
        json!({"principal":format!("account:{}",storage_player.id()),"sequence":"2"}),
    )
    .await?;
    assert_eq!(unchanged["data"]["kind"], "not_applied");
    assert_eq!(unchanged["data"]["high_water"], "1");
    storage_player
        .transfer_near(c.id(), near_workspaces::types::NearToken::from_near(1))
        .await?
        .into_result()?;
    let recovered: Value = storage_player
        .call(c.id(), "buy_from_merchant")
        .args_json(pending)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(recovered["data"]["outcome"]["buyer"]["gold"]["held"], "95");
    Ok(())
}
