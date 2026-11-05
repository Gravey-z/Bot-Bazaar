use super::living_town_adapter::rpc;
use super::living_town_production::{command, pinned, reject, snapshot, view};
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

pub(super) async fn capture(
    url: &str,
    c: &Contract,
    a: &Account,
    method: &str,
    args: Value,
) -> Result<Value> {
    let reference = view(c, "get_town", json!({})).await?;
    let result = a
        .call(c.id(), method)
        .args_json(args.clone())
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    let hash = result.outcome().transaction_hash.to_string();
    result.into_result()?;
    let receipt = rpc(
        url,
        "tx",
        json!({"tx_hash":hash,"sender_account_id":a.id(),"wait_until":"FINAL"}),
    )?;
    let root = receipt["transaction_outcome"]["outcome"]["status"]["SuccessReceiptId"]
        .as_str()
        .unwrap();
    let executed = receipt["receipts_outcome"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == root)
        .unwrap();
    let block = rpc(url, "block", json!({"block_id":executed["block_hash"]}))?;
    let account = rpc(
        url,
        "query",
        json!({"request_type":"view_account","account_id":c.id(),"block_id":executed["block_hash"]}),
    )?;
    let foundation = pinned(url, c, &block, "get_foundation", json!({}))?;
    Ok(
        json!({"method":method,"args":args,"signer_id":a.id(),"transaction_hash":hash,"reference_block_height":reference["block_height"],"receipt":receipt,"block":block,"account":account,"foundation":foundation}),
    )
}
fn set(shop: &str, item: &str, q: &str, price: &str, revision: Value, command: Value) -> Value {
    json!({"shop_id":shop,"item_id":item,"quantity":q,"unit_price":price,"expected_listing_revision":revision,"command":command})
}
async fn listings(c: &Contract, shop: &str, active: bool) -> Result<Value> {
    let town = view(c, "get_town", json!({})).await?;
    view(c,"get_listings",json!({"shop_id":shop,"item_id":null,"active_only":active,"after_id":null,"limit":"50","expected_market_revision":town["market_revision"]})).await
}
#[tokio::test]
async fn stock_replacement_reserves_only_held_outputs_and_rolls_back_failed_changes() -> Result<()>
{
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
    for (player, name) in [(&a, "Listed Potions"), (&b, "Other Shop")] {
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
    for (seq, merchant, item, q, cost) in [
        (3, "rex", "crystal", "3", "12"),
        (4, "luna", "herb", "6", "18"),
    ] {
        a.call(c.id(),"buy_from_merchant").args_json(json!({"merchant_id":merchant,"item_id":item,"quantity":q,"expected_listing_revision":"1","max_total_price":cost,"command":command(&c,seq).await?})).transact().await?.into_result()?;
    }
    a.call(c.id(),"start_production").args_json(json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"3","expected_shop_revision":"1","command":command(&c,5).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    reject(
        &c,
        &a,
        "set_listing",
        set(
            "4",
            "health_potion",
            "1",
            "18",
            Value::Null,
            command(&c, 6).await?,
        ),
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    reject(
        &c,
        &b,
        "set_listing",
        set(
            "4",
            "health_potion",
            "1",
            "18",
            Value::Null,
            command(&c, 3).await?,
        ),
        "LT:E_NOT_OWNER",
    )
    .await?;
    let job=view(&c,"get_production_jobs",json!({"shop_id":"4","status":"running","after_id":null,"limit":"50","expected_market_revision":view(&c,"get_town",json!({})).await?["market_revision"]})).await?;
    let ready = job["data"]["items"][0]["ready_at_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    for _ in 0..4 {
        if view(&c, "get_town", json!({})).await?["block_timestamp_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            >= ready
        {
            break;
        }
        worker.fast_forward(1000).await?;
    }
    b.call(c.id(), "complete_production")
        .args_json(json!({"job_id":"1"}))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let before = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    let before_state = snapshot(&url, &c)?;
    let mut steps = Vec::new();
    steps.push(
        capture(
            &url,
            &c,
            &a,
            "set_listing",
            set(
                "4",
                "health_potion",
                "2",
                "18",
                Value::Null,
                command(&c, 6).await?,
            ),
        )
        .await?,
    );
    let reduced = set(
        "4",
        "health_potion",
        "1",
        "19",
        json!("1"),
        command(&c, 7).await?,
    );
    steps.push(capture(&url, &c, &a, "set_listing", reduced.clone()).await?);
    let stable = c.view_state().await?;
    steps.push(capture(&url, &c, &a, "set_listing", reduced).await?);
    assert_eq!(c.view_state().await?, stable);
    reject(
        &c,
        &a,
        "set_listing",
        set(
            "4",
            "health_potion",
            "3",
            "18",
            json!("1"),
            command(&c, 8).await?,
        ),
        "LT:E_STALE_LISTING",
    )
    .await?;
    reject(
        &c,
        &a,
        "set_listing",
        set(
            "4",
            "health_potion",
            "4",
            "18",
            json!("2"),
            command(&c, 8).await?,
        ),
        "LT:E_INSUFFICIENT_AVAILABLE_STOCK",
    )
    .await?;
    reject(
        &c,
        &a,
        "set_listing",
        set("4", "crystal", "0", "4", Value::Null, command(&c, 8).await?),
        "LT:E_PLAYER_PRODUCTS_ONLY",
    )
    .await?;
    let args =
        json!({"listing_id":"5","expected_listing_revision":"2","command":command(&c,8).await?});
    steps.push(capture(&url, &c, &a, "cancel_listing", args).await?);
    assert!(
        listings(&c, "4", true).await?["data"]["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        listings(&c, "4", false).await?["data"]["items"][0]["revision"],
        "3"
    );
    reject(
        &c,
        &a,
        "set_listing",
        set(
            "4",
            "health_potion",
            "2",
            "20",
            Value::Null,
            command(&c, 9).await?,
        ),
        "LT:E_STALE_LISTING",
    )
    .await?;
    steps.push(
        capture(
            &url,
            &c,
            &a,
            "set_listing",
            set(
                "4",
                "health_potion",
                "2",
                "20",
                json!("3"),
                command(&c, 9).await?,
            ),
        )
        .await?,
    );
    steps.push(
        capture(
            &url,
            &c,
            &a,
            "set_listing",
            set(
                "4",
                "health_potion",
                "0",
                "20",
                json!("4"),
                command(&c, 10).await?,
            ),
        )
        .await?,
    );
    reject(
        &c,
        &a,
        "cancel_listing",
        json!({"listing_id":"5","expected_listing_revision":"5","command":command(&c,11).await?}),
        "LT:E_LISTING_INACTIVE",
    )
    .await?;
    steps.push(
        capture(
            &url,
            &c,
            &a,
            "set_listing",
            set(
                "4",
                "health_potion",
                "3",
                "20",
                json!("5"),
                command(&c, 11).await?,
            ),
        )
        .await?,
    );
    steps.push(
        capture(
            &url,
            &c,
            &rex,
            "set_listing",
            set("1", "crystal", "4", "3", json!("2"), command(&c, 1).await?),
        )
        .await?,
    );
    steps.push(capture(&url,&c,&rex,"cancel_listing",json!({"listing_id":"1","expected_listing_revision":"3","command":command(&c,2).await?})).await?);
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
    reject(
        &c,
        &a,
        "set_listing",
        set(
            "4",
            "health_potion",
            "2",
            "21",
            json!("6"),
            command(&c, 12).await?,
        ),
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    let after = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    assert_eq!(after["data"]["gold"], before["data"]["gold"]);
    assert_eq!(
        after["data"]["inventory"]["held"],
        before["data"]["inventory"]["held"]
    );
    assert_eq!(
        after["data"]["inventory"]["listing_reserved"]["health_potion"],
        "3"
    );
    let after_state = snapshot(&url, &c)?;
    ensure!(view(&c, "get_town", json!({})).await?["data"]["next_listing_id"] == "6");
    println!(
        "LISTING_SANDBOX={}",
        json!({"source":"actual disposable local WASM sandbox; synthetic declared genesis; not Testnet","contract_id":c.id(),"before":before,"after":after,"before_state":before_state,"after_state":after_state,"steps":steps})
    );
    Ok(())
}
