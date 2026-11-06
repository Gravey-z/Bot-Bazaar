use super::living_town_adapter::rpc;
use super::living_town_production::{command, pinned, reject, snapshot, view};
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use near_workspaces::{Account, Contract, Worker, network::Sandbox};
use serde_json::{Value, json};

async fn next(c: &Contract, principal: String) -> Result<Value> {
    let lookup = view(
        c,
        "get_command",
        json!({"principal":principal,"sequence":u64::MAX.to_string()}),
    )
    .await?;
    command(
        c,
        lookup["data"]["next_sequence"].as_str().unwrap().parse()?,
    )
    .await
}
async fn owner_command(c: &Contract, a: &Account) -> Result<Value> {
    next(c, format!("account:{}", a.id())).await
}
async fn set(
    c: &Contract,
    a: &Account,
    shop: &str,
    item: &str,
    q: &str,
    price: &str,
    revision: Value,
) -> Result<Value> {
    let principal = if shop == "1" {
        "merchant:rex".to_owned()
    } else if shop == "3" {
        "merchant:bolt".to_owned()
    } else {
        format!("account:{}", a.id())
    };
    Ok(
        json!({"shop_id":shop,"item_id":item,"quantity":q,"unit_price":price,"expected_listing_revision":revision,"command":next(c,principal).await?}),
    )
}
async fn row(c: &Contract, shop: &str, item: &str) -> Result<Value> {
    let t = view(c, "get_town", json!({})).await?;
    let page=view(c,"get_listings",json!({"shop_id":shop,"item_id":item,"active_only":false,"after_id":null,"limit":"50","expected_market_revision":t["market_revision"]})).await?;
    Ok(page["data"]["items"][0].clone())
}
async fn epoch(worker: &Worker<Sandbox>, c: &Contract) -> Result<Value> {
    for _ in 0..6 {
        let t = view(c, "get_town", json!({})).await?;
        let offset = (t["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?
            - t["data"]["genesis_time_ns"]
                .as_str()
                .unwrap()
                .parse::<u64>()?)
            % 60_000_000_000;
        if offset < 30_000_000_000 {
            return Ok(t["data"]["epoch"].clone());
        }
        worker.fast_forward(50).await?;
    }
    anyhow::bail!("could not align disposable epoch margin")
}
async fn sale(c: &Contract, operator: &Account, listing: &Value, e: Value) -> Result<Value> {
    Ok(
        json!({"listing_id":listing["listing_id"],"expected_listing_revision":listing["revision"],"epoch":e,"max_total_price":listing["unit_price"],"command":owner_command(c,operator).await?}),
    )
}
// Capture both winning and losing finalized receipts; a failed execution is not a transport error.
pub(super) async fn call(
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
    let succeeded = result.is_success();
    let (effect, error) = if succeeded {
        (result.json::<Value>()?, Value::Null)
    } else {
        (
            Value::Null,
            json!(result.into_result().unwrap_err().to_string()),
        )
    };
    let receipt = rpc(
        url,
        "tx",
        json!({"tx_hash":hash,"sender_account_id":a.id(),"wait_until":"FINAL"}),
    )?;
    let root = receipt["transaction_outcome"]["outcome"]["status"]["SuccessReceiptId"]
        .as_str()
        .unwrap();
    let execution = receipt["receipts_outcome"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == root)
        .unwrap();
    let block = rpc(url, "block", json!({"block_id":execution["block_hash"]}))?;
    let account = rpc(
        url,
        "query",
        json!({"request_type":"view_account","account_id":c.id(),"block_id":execution["block_hash"]}),
    )?;
    let foundation = pinned(url, c, &block, "get_foundation", json!({}))?;
    Ok(
        json!({"method":method,"args":args,"signer_id":a.id(),"transaction_hash":hash,"reference_block_height":reference["block_height"],"succeeded":succeeded,"effect":effect,"error":error,"receipt":receipt,"block":block,"account":account,"foundation":foundation}),
    )
}
fn one_winner(calls: &[Value]) {
    assert_eq!(calls.iter().filter(|r| r["succeeded"] == true).count(), 1);
}
fn number(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}
fn conserve(s: &Value) {
    let t = &s["town"]["data"];
    let totals = &t["totals"];
    let ledgers: Vec<&Value> = t["npc_ledgers"]
        .as_array()
        .unwrap()
        .iter()
        .chain(
            s["shops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| &r["ledger"]["data"]),
        )
        .collect();
    let gold = ledgers
        .iter()
        .map(|l| number(&l["gold"]["held"]))
        .sum::<u128>()
        + number(&t["customer_pool"]["gold"]);
    assert_eq!(
        gold,
        number(&totals["initial_gold"])
            + number(&totals["player_grants"])
            + number(&totals["customer_topups"])
            - number(&totals["upgrade_burns"])
            - number(&totals["treasury_burns"])
    );
    for item in [
        "crystal",
        "wood",
        "herb",
        "iron",
        "health_potion",
        "iron_tool",
    ] {
        let held = ledgers
            .iter()
            .map(|l| number(&l["inventory"]["held"][item]))
            .sum::<u128>();
        assert_eq!(
            held + number(&totals["recipe_inputs_consumed"][item])
                + number(&totals["customer_consumed"][item]),
            number(&totals["seed_items"][item])
                + number(&totals["supplied_items"][item])
                + number(&totals["completed_outputs"][item]),
            "{item}"
        );
        for ledger in &ledgers {
            let inv = &ledger["inventory"];
            assert_eq!(
                number(&inv["held"][item]),
                number(&inv["available"][item])
                    + number(&inv["listing_reserved"][item])
                    + number(&inv["trade_reserved"][item])
            );
            assert!(
                number(&inv["held"][item])
                    + number(&inv["production_output_reserved"][item])
                    + number(&inv["trade_inbound_reserved"][item])
                    <= 1000
            );
        }
    }
}
fn stage(name: &str, before: Value, after: Value, calls: Vec<Value>) -> Value {
    conserve(&before);
    conserve(&after);
    json!({"name":name,"before":before,"after":after,"calls":calls})
}

#[tokio::test]
async fn sales_races_and_conservation_cover_last_unit_reservations_funding_and_pruned_retries()
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
    let bolt = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    let url = worker.rpc_addr();
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":operator.id(),"merchant_controllers":{"rex":rex.id(),"luna":"luna.testnet","bolt":bolt.id()},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    let mut setup = Vec::new();
    let mut stages = Vec::new();
    for (account, name) in [(&a, "Race Potions"), (&b, "Race Buyer")] {
        setup.push(
            call(
                &url,
                &c,
                account,
                "register_player",
                json!({"command":command(&c,1).await?}),
            )
            .await?,
        );
        setup.push(
            call(
                &url,
                &c,
                account,
                "create_shop",
                json!({"name":name,"command":command(&c,2).await?}),
            )
            .await?,
        );
    }
    setup.push(
        call(
            &url,
            &c,
            &rex,
            "set_listing",
            set(&c, &rex, "1", "crystal", "1", "4", json!("1")).await?,
        )
        .await?,
    );
    let before = snapshot(&url, &c)?;
    let args_a = json!({"merchant_id":"rex","item_id":"crystal","quantity":"1","expected_listing_revision":"2","max_total_price":"4","command":owner_command(&c,&a).await?});
    let mut args_b = args_a.clone();
    args_b["command"] = owner_command(&c, &b).await?;
    let (left, right) = tokio::join!(
        call(&url, &c, &a, "buy_from_merchant", args_a),
        call(&url, &c, &b, "buy_from_merchant", args_b)
    );
    let calls = vec![left?, right?];
    one_winner(&calls);
    assert!(
        calls
            .iter()
            .filter(|r| r["succeeded"] == false)
            .all(|r| r["error"].as_str().unwrap().contains("LT:E_STALE_LISTING"))
    );
    stages.push(stage("last_raw_unit", before, snapshot(&url, &c)?, calls));

    for (item, q, rev) in [("wood", "7", "1"), ("iron", "14", "1")] {
        setup.push(
            call(
                &url,
                &c,
                &bolt,
                "set_listing",
                set(
                    &c,
                    &bolt,
                    "3",
                    item,
                    q,
                    if item == "wood" { "2" } else { "5" },
                    json!(rev),
                )
                .await?,
            )
            .await?,
        );
    }
    let before = snapshot(&url, &c)?;
    let reserve = set(&c, &bolt, "3", "wood", "8", "2", json!("2")).await?;
    let craft = json!({"shop_id":"3","recipe_id":"iron_tool","recipe_version":"1","quantity":"3","expected_shop_revision":"1","command":reserve["command"]});
    let (left, right) = tokio::join!(
        call(&url, &c, &bolt, "start_production", craft.clone()),
        call(&url, &c, &bolt, "set_listing", reserve.clone())
    );
    let calls = vec![left?, right?];
    one_winner(&calls);
    let craft_won = calls[0]["succeeded"] == true;
    let mut retry = if craft_won { reserve } else { craft };
    retry["command"] = next(&c, "merchant:bolt".to_owned()).await?;
    reject(
        &c,
        &bolt,
        if craft_won {
            "set_listing"
        } else {
            "start_production"
        },
        retry,
        if craft_won {
            "LT:E_INSUFFICIENT_AVAILABLE_STOCK"
        } else {
            "LT:E_INSUFFICIENT_INPUTS"
        },
    )
    .await?;
    stages.push(stage(
        "craft_versus_reserve",
        before,
        snapshot(&url, &c)?,
        calls,
    ));

    setup.push(
        call(
            &url,
            &c,
            &rex,
            "set_listing",
            set(&c, &rex, "1", "crystal", "3", "4", json!("3")).await?,
        )
        .await?,
    );
    for (merchant, item, q, rev, cost) in [
        ("rex", "crystal", "3", "4", "12"),
        ("luna", "herb", "6", "1", "18"),
    ] {
        setup.push(call(&url,&c,&a,"buy_from_merchant",json!({"merchant_id":merchant,"item_id":item,"quantity":q,"expected_listing_revision":rev,"max_total_price":cost,"command":owner_command(&c,&a).await?})).await?);
    }
    let started=call(&url,&c,&a,"start_production",json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":"3","expected_shop_revision":"1","command":owner_command(&c,&a).await?})).await?;
    ensure!(started["succeeded"] == true);
    let job = started["effect"]["data"]["outcome"]["job"].clone();
    setup.push(started);
    for _ in 0..4 {
        if number(&view(&c, "get_town", json!({})).await?["block_timestamp_ns"])
            >= number(&job["ready_at_ns"])
        {
            break;
        }
        worker.fast_forward(1000).await?;
    }
    setup.push(
        call(
            &url,
            &c,
            &operator,
            "complete_production",
            json!({"job_id":job["job_id"]}),
        )
        .await?,
    );
    setup.push(
        call(
            &url,
            &c,
            &a,
            "set_listing",
            set(&c, &a, "4", "health_potion", "1", "18", Value::Null).await?,
        )
        .await?,
    );
    for reprice in [false, true] {
        if reprice {
            let listing = row(&c, "4", "health_potion").await?;
            setup.push(
                call(
                    &url,
                    &c,
                    &a,
                    "set_listing",
                    set(
                        &c,
                        &a,
                        "4",
                        "health_potion",
                        "1",
                        "18",
                        listing["revision"].clone(),
                    )
                    .await?,
                )
                .await?,
            );
        }
        let e = epoch(&worker, &c).await?;
        let listing = row(&c, "4", "health_potion").await?;
        let before = snapshot(&url, &c)?;
        let purchase = sale(&c, &operator, &listing, e).await?;
        let edit = if reprice {
            set(
                &c,
                &a,
                "4",
                "health_potion",
                "1",
                "17",
                listing["revision"].clone(),
            )
            .await?
        } else {
            json!({"listing_id":listing["listing_id"],"expected_listing_revision":listing["revision"],"command":owner_command(&c,&a).await?})
        };
        let (left, right) = tokio::join!(
            call(&url, &c, &operator, "settle_customer_purchase", purchase),
            call(
                &url,
                &c,
                &a,
                if reprice {
                    "set_listing"
                } else {
                    "cancel_listing"
                },
                edit
            )
        );
        let calls = vec![left?, right?];
        one_winner(&calls);
        assert!(
            calls
                .iter()
                .filter(|r| r["succeeded"] == false)
                .all(|r| r["error"].as_str().unwrap().contains("LT:E_STALE_LISTING"))
        );
        stages.push(stage(
            if reprice {
                "sale_versus_reprice"
            } else {
                "sale_versus_cancel"
            },
            before,
            snapshot(&url, &c)?,
            calls,
        ));
    }
    let mut retained = stages
        .iter()
        .flat_map(|s| s["calls"].as_array().unwrap())
        .rfind(|r| r["method"] == "settle_customer_purchase" && r["succeeded"] == true)
        .cloned();
    if retained.is_none() {
        let e = epoch(&worker, &c).await?;
        let listing = row(&c, "4", "health_potion").await?;
        let record = call(
            &url,
            &c,
            &operator,
            "settle_customer_purchase",
            sale(&c, &operator, &listing, e).await?,
        )
        .await?;
        ensure!(record["succeeded"] == true);
        setup.push(record.clone());
        retained = Some(record);
    }
    let retained = retained.unwrap();
    let before = snapshot(&url, &c)?;
    let stable = c.view_state().await?;
    let replay = call(
        &url,
        &c,
        &operator,
        "settle_customer_purchase",
        retained["args"].clone(),
    )
    .await?;
    assert_eq!(replay["effect"]["data"]["replayed"], true);
    assert_eq!(c.view_state().await?, stable);
    let mut altered = retained["args"].clone();
    altered["max_total_price"] = json!("1");
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        altered,
        "LT:E_COMMAND_CONFLICT",
    )
    .await?;
    stages.push(stage(
        "retained_sale_replay",
        before,
        snapshot(&url, &c)?,
        vec![replay],
    ));

    let e = epoch(&worker, &c).await?;
    let args = json!({"epoch":e,"command":owner_command(&c,&operator).await?});
    let before = snapshot(&url, &c)?;
    let (left, right) = tokio::join!(
        call(&url, &c, &operator, "fund_customer_budget", args.clone()),
        call(&url, &c, &operator, "fund_customer_budget", args.clone())
    );
    let calls = vec![left?, right?];
    assert!(calls.iter().all(|r| r["succeeded"] == true));
    assert_eq!(
        calls
            .iter()
            .filter(|r| r["effect"]["data"]["replayed"] == false)
            .count(),
        1
    );
    stages.push(stage(
        "duplicate_funding",
        before,
        snapshot(&url, &c)?,
        calls,
    ));
    reject(
        &c,
        &operator,
        "settle_customer_purchase",
        retained["args"].clone(),
        "LT:E_COMMAND_PRUNED",
    )
    .await?;
    let old=view(&c,"get_command",json!({"principal":format!("account:{}",operator.id()),"sequence":retained["args"]["command"]["sequence"]})).await?;
    assert_eq!(old["data"]["kind"], "pruned");
    let mut changed = args.clone();
    changed["epoch"] = json!((number(&args["epoch"]) + 1).to_string());
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        changed,
        "LT:E_COMMAND_CONFLICT",
    )
    .await?;
    reject(
        &c,
        &operator,
        "fund_customer_budget",
        json!({"epoch":args["epoch"],"command":owner_command(&c,&operator).await?}),
        "LT:E_EPOCH_ALLOCATED",
    )
    .await?;
    let final_state = snapshot(&url, &c)?;
    conserve(&final_state);
    assert!(setup.iter().all(|r| r["succeeded"] == true));
    println!(
        "SALES_RACES_SANDBOX={}",
        json!({"source":"actual disposable local WASM sandbox; concurrent signed requests and accelerated time; synthetic declared genesis; not Testnet","setup":setup,"stages":stages,"after":final_state,"pruned_command":old})
    );
    Ok(())
}
