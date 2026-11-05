use super::living_town_listings::capture;
use super::living_town_production::{command, reject, snapshot};
use super::{canonical, wasm};
use anyhow::Result;
use near_workspaces::Contract;
use serde_json::{Value, json};

async fn buy(c: &Contract, seq: u64, revision: &str, max: &str) -> Result<Value> {
    Ok(
        json!({"merchant_id":"rex","item_id":"crystal","quantity":"1","expected_listing_revision":revision,"max_total_price":max,"command":command(c,seq).await?}),
    )
}
async fn listing(
    c: &Contract,
    seq: u64,
    revision: &str,
    quantity: &str,
    price: &str,
) -> Result<Value> {
    Ok(
        json!({"shop_id":"1","item_id":"crystal","quantity":quantity,"unit_price":price,"expected_listing_revision":revision,"command":command(c,seq).await?}),
    )
}
#[tokio::test]
async fn edited_listings_settle_once_with_conservation_and_no_arbitrary_counterparties()
-> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let c = worker.dev_deploy(&wasm()?).await?;
    let a = worker.dev_create_account().await?;
    let b = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let url = worker.rpc_addr();
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":"operator.testnet","merchant_controllers":{"rex":rex.id(),"luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    for (player, name) in [(&a, "Buyer A"), (&b, "Buyer B")] {
        player
            .call(c.id(), "register_player")
            .args_json(json!({"command":command(&c,1).await?}))
            .transact()
            .await?
            .into_result()?;
        player
            .call(c.id(), "create_shop")
            .args_json(json!({"name":name,"command":command(&c,2).await?}))
            .transact()
            .await?
            .into_result()?;
    }
    rex.call(c.id(), "set_listing")
        .args_json(listing(&c, 1, "1", "4", "3").await?)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    reject(
        &c,
        &a,
        "buy_from_merchant",
        buy(&c, 3, "1", "3").await?,
        "LT:E_STALE_LISTING",
    )
    .await?;
    rex.call(c.id(), "set_listing")
        .args_json(listing(&c, 2, "2", "2", "5").await?)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    reject(
        &c,
        &a,
        "buy_from_merchant",
        buy(&c, 3, "3", "4").await?,
        "LT:E_MAX_TOTAL",
    )
    .await?;
    // Current controller cannot buy from its own NPC using a player lane.
    reject(
        &c,
        &rex,
        "buy_from_merchant",
        buy(&c, 1, "3", "5").await?,
        "LT:E_RESERVED_ACCOUNT",
    )
    .await?;
    let mut forged = buy(&c, 3, "3", "5").await?;
    forged["buyer_account_id"] = json!(a.id());
    reject(&c, &b, "buy_from_merchant", forged, "LT:E_INVALID_ARGUMENT").await?;
    reject(
        &c,
        &a,
        "purchase_listing",
        json!({"buyer":a.id(),"seller":b.id(),"listing_id":"1"}),
        "MethodNotFound",
    )
    .await?;
    let mut product = buy(&c, 3, "3", "5").await?;
    product["item_id"] = json!("health_potion");
    reject(
        &c,
        &a,
        "buy_from_merchant",
        product,
        "LT:E_INVALID_ARGUMENT",
    )
    .await?;
    let before = snapshot(&url, &c)?;
    let mut steps = Vec::new();
    let original = buy(&c, 3, "3", "5").await?;
    steps.push(capture(&url, &c, &a, "buy_from_merchant", original.clone()).await?);
    let stable = c.view_state().await?;
    steps.push(capture(&url, &c, &a, "buy_from_merchant", original.clone()).await?);
    assert_eq!(c.view_state().await?, stable);
    let mut conflict = original.clone();
    conflict["quantity"] = json!("2");
    conflict["max_total_price"] = json!("10");
    reject(
        &c,
        &a,
        "buy_from_merchant",
        conflict,
        "LT:E_COMMAND_CONFLICT",
    )
    .await?;
    reject(
        &c,
        &b,
        "buy_from_merchant",
        buy(&c, 3, "3", "5").await?,
        "LT:E_STALE_LISTING",
    )
    .await?;
    steps.push(
        capture(
            &url,
            &c,
            &b,
            "buy_from_merchant",
            buy(&c, 3, "4", "5").await?,
        )
        .await?,
    );
    reject(
        &c,
        &rex,
        "cancel_listing",
        json!({"listing_id":"1","expected_listing_revision":"5","command":command(&c,3).await?}),
        "LT:E_LISTING_INACTIVE",
    )
    .await?;
    rex.call(c.id(), "set_listing")
        .args_json(listing(&c, 3, "5", "1", "6").await?)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    // Replay must return the original acknowledgement even after another buyer
    // purchases and the seller reprices/replaces its remaining listing.
    let stable = c.view_state().await?;
    steps.push(capture(&url, &c, &a, "buy_from_merchant", original.clone()).await?);
    assert_eq!(c.view_state().await?, stable);
    let native = c.view_account().await?;
    let keep =
        u128::from(native.storage_usage) * near_sdk::env::storage_byte_cost().as_yoctonear() * 11
            / 10;
    c.as_account()
        .transfer_near(
            b.id(),
            near_workspaces::types::NearToken::from_yoctonear(native.balance.as_yoctonear() - keep),
        )
        .await?
        .into_result()?;
    let final_buy = buy(&c, 4, "6", "6").await?;
    reject(
        &c,
        &a,
        "buy_from_merchant",
        final_buy.clone(),
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    b.transfer_near(c.id(), near_workspaces::types::NearToken::from_near(1))
        .await?
        .into_result()?;
    steps.push(capture(&url, &c, &a, "buy_from_merchant", final_buy).await?);
    reject(&c, &a, "buy_from_merchant", original, "LT:E_COMMAND_PRUNED").await?;
    reject(
        &c,
        &a,
        "buy_from_merchant",
        buy(&c, 5, "7", "6").await?,
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    reject(&c,&a,"set_listing",json!({"shop_id":"4","item_id":"crystal","quantity":"1","unit_price":"4","expected_listing_revision":null,"command":command(&c,5).await?}),"LT:E_PLAYER_PRODUCTS_ONLY").await?;
    rex.call(c.id(), "set_listing")
        .args_json(listing(&c, 4, "7", "1", "4").await?)
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    rex.call(c.id(),"cancel_listing").args_json(json!({"listing_id":"1","expected_listing_revision":"8","command":command(&c,5).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    reject(
        &c,
        &a,
        "buy_from_merchant",
        buy(&c, 5, "9", "4").await?,
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    let after = snapshot(&url, &c)?;
    for (index, gold, held) in [(0, "89", "2"), (1, "95", "1")] {
        assert_eq!(
            after["shops"][index]["ledger"]["data"]["gold"]["held"],
            gold
        );
        assert_eq!(
            after["shops"][index]["ledger"]["data"]["inventory"]["held"]["crystal"],
            held
        );
    }
    assert_eq!(
        after["town"]["data"]["npc_ledgers"][0]["gold"]["held"],
        "216"
    );
    assert_eq!(
        after["town"]["data"]["npc_ledgers"][0]["inventory"]["held"]["crystal"],
        "7"
    );
    assert_eq!(
        after["town"]["data"]["npc_ledgers"][0]["inventory"]["listing_reserved"]["crystal"],
        "0"
    );
    assert_eq!(after["town"]["data"]["next_trade_id"], "4");
    assert_eq!(
        after["town"]["data"]["totals"],
        before["town"]["data"]["totals"]
    );
    println!(
        "SETTLEMENT_SANDBOX={}",
        json!({"source":"actual disposable local WASM sandbox; synthetic declared genesis; not Testnet","contract_id":c.id(),"before":before,"after":after,"steps":steps})
    );
    Ok(())
}
