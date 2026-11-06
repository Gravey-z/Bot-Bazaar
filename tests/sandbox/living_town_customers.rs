use super::living_town_listings::capture;
use super::living_town_production::{command, pinned, reject, snapshot, view};
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use near_workspaces::Contract;
use serde_json::{Value, json};
async fn current(c: &Contract) -> Result<u64> {
    Ok(view(c, "get_town", json!({})).await?["data"]["epoch"]
        .as_str()
        .unwrap()
        .parse()?)
}
async fn fund(c: &Contract, e: u64, seq: u64) -> Result<Value> {
    Ok(json!({"epoch":e.to_string(),"command":command(c,seq).await?}))
}
async fn sale(
    c: &Contract,
    id: &str,
    revision: &str,
    e: u64,
    seq: u64,
    cap: &str,
) -> Result<Value> {
    Ok(
        json!({"listing_id":id,"expected_listing_revision":revision,"epoch":e.to_string(),"max_total_price":cap,"command":command(c,seq).await?}),
    )
}
#[tokio::test]
async fn funded_customers_consume_real_products_with_global_quotas_and_capped_epoch_sources()
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
    let operator = worker.dev_create_account().await?;
    let url = worker.rpc_addr();
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":operator.id(),"merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        fund(&c, 0, 1).await?,
        "LT:E_EPOCH_ALLOCATED",
    )
    .await?;
    reject(
        &c,
        &a,
        "fund_customer_budget",
        fund(&c, 0, 1).await?,
        "LT:E_UNAUTHORIZED",
    )
    .await?;
    for (player, name) in [(&a, "Customer Potions"), (&b, "Customer Tools")] {
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
    for (player, seq, merchant, item, q, cost) in [
        (&a, 3, "rex", "crystal", "3", "12"),
        (&a, 4, "luna", "herb", "6", "18"),
        (&b, 3, "bolt", "wood", "3", "6"),
        (&b, 4, "bolt", "iron", "6", "30"),
    ] {
        player.call(c.id(),"buy_from_merchant").args_json(json!({"merchant_id":merchant,"item_id":item,"quantity":q,"expected_listing_revision":"1","max_total_price":cost,"command":command(&c,seq).await?})).transact().await?.into_result()?;
    }
    for (player, shop, recipe) in [(&a, "4", "health_potion"), (&b, "5", "iron_tool")] {
        capture(&url, &c, player, "start_production", json!({"shop_id":shop,"recipe_id":recipe,"recipe_version":"1","quantity":"3","expected_shop_revision":"1","command":command(&c,5).await?})).await?;
    }
    let running = snapshot(&url, &c)?;
    let ready = running["shops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            s["jobs"]["data"]["items"][0]["ready_at_ns"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        })
        .max()
        .unwrap();
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
    for id in ["1", "2"] {
        operator
            .call(c.id(), "complete_production")
            .args_json(json!({"job_id":id}))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
    }
    for (player, shop, item, price) in [
        (&a, "4", "health_potion", "100"),
        (&b, "5", "iron_tool", "24"),
    ] {
        player.call(c.id(),"set_listing").args_json(json!({"shop_id":shop,"item_id":item,"quantity":"3","unit_price":price,"expected_listing_revision":null,"command":command(&c,6).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    }
    // Keep a generous margin inside one epoch for the four quota purchases.
    for _ in 0..4 {
        let t = view(&c, "get_town", json!({})).await?;
        let elapsed = (t["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?
            - t["data"]["genesis_time_ns"]
                .as_str()
                .unwrap()
                .parse::<u64>()?)
            % 60_000_000_000;
        if elapsed < 30_000_000_000 {
            break;
        }
        worker.fast_forward(50).await?;
    }
    let e = current(&c).await?;
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        sale(&c, "5", "1", e, 1, "100").await?,
        "LT:E_NO_DEMAND",
    )
    .await?;
    a.call(c.id(),"set_listing").args_json(json!({"shop_id":"4","item_id":"health_potion","quantity":"3","unit_price":"18","expected_listing_revision":"1","command":command(&c,7).await?})).gas(near_workspaces::types::Gas::from_tgas(100)).transact().await?.into_result()?;
    reject(
        &c,
        &a,
        "settle_customer_purchase",
        sale(&c, "5", "2", e, 8, "18").await?,
        "LT:E_UNAUTHORIZED",
    )
    .await?;
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        sale(&c, "1", "2", e, 1, "18").await?,
        "LT:E_CUSTOMER_SELLER",
    )
    .await?;
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        sale(&c, "5", "2", e + 1, 1, "18").await?,
        "LT:E_EPOCH_MISMATCH",
    )
    .await?;
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        sale(&c, "5", "2", e, 1, "17").await?,
        "LT:E_MAX_TOTAL",
    )
    .await?;
    let mut invalid = sale(&c, "5", "2", e, 1, "18").await?;
    invalid["quantity"] = json!("2");
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        invalid,
        "LT:E_INVALID_ARGUMENT",
    )
    .await?;
    let mut invalid = sale(&c, "5", "2", e, 1, "18").await?;
    invalid["buyer_account_id"] = json!(b.id());
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        invalid,
        "LT:E_INVALID_ARGUMENT",
    )
    .await?;
    let before = snapshot(&url, &c)?;
    let mut steps = Vec::new();
    let first = sale(&c, "5", "2", e, 1, "18").await?;
    steps.push(
        capture(
            &url,
            &c,
            &operator,
            "settle_customer_purchase",
            first.clone(),
        )
        .await?,
    );
    let stable = c.view_state().await?;
    steps.push(capture(&url, &c, &operator, "settle_customer_purchase", first).await?);
    assert_eq!(c.view_state().await?, stable);
    for (seq, id, revision, cap) in [
        (2, "5", "3", "18"),
        (3, "6", "1", "24"),
        (4, "6", "2", "24"),
    ] {
        steps.push(
            capture(
                &url,
                &c,
                &operator,
                "settle_customer_purchase",
                sale(&c, id, revision, e, seq, cap).await?,
            )
            .await?,
        );
    }
    ensure!(current(&c).await? == e, "quota proof crossed epoch");
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        sale(&c, "5", "4", e, 5, "18").await?,
        "LT:E_CUSTOMER_QUOTA",
    )
    .await?;
    let after_quota = snapshot(&url, &c)?;
    assert_eq!(after_quota["town"]["data"]["customer_pool"]["gold"], "16");
    worker.fast_forward(250).await?;
    let next = current(&c).await?;
    ensure!(next > e);
    let rollover = snapshot(&url, &c)?;
    assert_eq!(
        rollover["town"]["data"]["customer_pool"]["potion_units_bought"],
        "0"
    );
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        sale(&c, "5", "4", next, 5, "18").await?,
        "LT:E_CUSTOMER_BUDGET",
    )
    .await?;
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        fund(&c, e, 5).await?,
        "LT:E_EPOCH_MISMATCH",
    )
    .await?;
    let funding = fund(&c, next, 5).await?;
    steps.push(capture(&url, &c, &operator, "fund_customer_budget", funding.clone()).await?);
    let stable = c.view_state().await?;
    steps.push(capture(&url, &c, &operator, "fund_customer_budget", funding).await?);
    assert_eq!(c.view_state().await?, stable);
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        fund(&c, next, 6).await?,
        "LT:E_EPOCH_ALLOCATED",
    )
    .await?;
    steps.push(
        capture(
            &url,
            &c,
            &operator,
            "settle_customer_purchase",
            sale(&c, "5", "4", next, 6, "18").await?,
        )
        .await?,
    );
    let after_sale = snapshot(&url, &c)?;
    assert_eq!(after_sale["town"]["data"]["customer_pool"]["gold"], "98");
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        fund(&c, next, 7).await?,
        "LT:E_EPOCH_ALLOCATED",
    )
    .await?;
    for seq in 7..=9 {
        worker.fast_forward(250).await?;
        let epoch = current(&c).await?;
        steps.push(
            capture(
                &url,
                &c,
                &operator,
                "fund_customer_budget",
                fund(&c, epoch, seq).await?,
            )
            .await?,
        );
    }
    let zero = view(
        &c,
        "get_command",
        json!({"principal":format!("account:{}",operator.id()),"sequence":"9"}),
    )
    .await?;
    assert_eq!(zero["data"]["effect"]["outcome"]["issued_gold"], "0");
    let stable = c.view_state().await?;
    steps.push(
        capture(
            &url,
            &c,
            &operator,
            "fund_customer_budget",
            steps.last().unwrap()["args"].clone(),
        )
        .await?,
    );
    assert_eq!(c.view_state().await?, stable);
    let last_epoch = current(&c).await?;
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        fund(&c, last_epoch, 10).await?,
        "LT:E_EPOCH_ALLOCATED",
    )
    .await?;
    let native = c.view_account().await?;
    let keep =
        u128::from(native.storage_usage) * near_sdk::env::storage_byte_cost().as_yoctonear() * 11
            / 10;
    c.as_account()
        .transfer_near(
            operator.id(),
            near_workspaces::types::NearToken::from_yoctonear(native.balance.as_yoctonear() - keep),
        )
        .await?
        .into_result()?;
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        sale(&c, "6", "3", last_epoch, 10, "24").await?,
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    worker.fast_forward(250).await?;
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        fund(&c, current(&c).await?, 10).await?,
        "LT:E_STORAGE_CAPACITY",
    )
    .await?;
    let after = snapshot(&url, &c)?;
    let trade = pinned(
        &url,
        &c,
        &after["block"],
        "get_trade",
        json!({"trade_id":"5"}),
    )?;
    let operator_command = pinned(
        &url,
        &c,
        &after["block"],
        "get_command",
        json!({"principal":format!("account:{}",operator.id()),"sequence":"9"}),
    )?;
    assert_eq!(after["town"]["data"]["customer_pool"]["gold"], "200");
    assert_eq!(after["town"]["data"]["totals"]["customer_topups"], "202");
    assert_eq!(
        after["town"]["data"]["totals"]["customer_consumed"]["health_potion"],
        "3"
    );
    assert_eq!(
        after["town"]["data"]["totals"]["customer_consumed"]["iron_tool"],
        "2"
    );
    assert_eq!(after["shops"][0]["ledger"]["data"]["gold"]["held"], "124");
    assert_eq!(after["shops"][1]["ledger"]["data"]["gold"]["held"], "112");
    assert_eq!(trade["data"]["value"]["buyer"], Value::Null);
    println!(
        "CUSTOMER_SANDBOX={}",
        json!({"source":"actual disposable local WASM sandbox; accelerated sandbox time; synthetic declared genesis; not Testnet","contract_id":c.id(),"before":before,"after_quota":after_quota,"rollover":rollover,"after_sale":after_sale,"after":after,"trade":trade,"operator_command":operator_command,"steps":steps})
    );
    Ok(())
}
