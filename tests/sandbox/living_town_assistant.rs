use super::living_town_production::{command, view};
use super::living_town_sales_races::call;
use super::{canonical, wasm};
use anyhow::{Result, ensure};
use serde_json::{Value, json};

#[tokio::test]
async fn assistant_permissions_are_owner_only_bounded_revisioned_and_replay_safe() -> Result<()> {
    let abi: Value = serde_json::from_slice(&std::fs::read(
        "../../target/near/living-town/bot_bazaar_living_town_abi.json",
    )?)?;
    assert_eq!(
        abi["body"]["root_schema"]["definitions"]["Decimal"]["type"], "string",
        "ABI must describe the canonical decimal string wire type"
    );
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let w = near_workspaces::sandbox().await?;
    let c = w.dev_deploy(&wasm()?).await?;
    let op = w.dev_create_account().await?;
    let rex = w.dev_create_account().await?;
    let luna = w.dev_create_account().await?;
    let bolt = w.dev_create_account().await?;
    let player = w.dev_create_account().await?;
    let other = w.dev_create_account().await?;
    c.call("initialize_town").args_json(json!({"owner_account_id":c.id(),"operator_account_id":op.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest})).transact().await?.into_result()?;
    let url = w.rpc_addr();
    let mut steps = vec![];
    steps.push(
        call(
            &url,
            &c,
            &player,
            "register_player",
            json!({"command":command(&c,1).await?}),
        )
        .await?,
    );
    steps.push(
        call(
            &url,
            &c,
            &player,
            "create_shop",
            json!({"name":"Scoped assistant","command":command(&c,2).await?}),
        )
        .await?,
    );
    let initial = view(&c, "get_assistant_policy", json!({"shop_id":"4"})).await?;
    assert_eq!(initial["data"]["mode"], "off");
    let ledger = view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?;
    let time = view(&c, "get_town", json!({})).await?["block_timestamp_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    let policy = json!({"mode":"auto_reprice","operator_account_id":op.id(),"allowed_items":["iron_tool","health_potion"],"min_price":"5","max_price":"25","expires_at_ns":(time+200_000_000_000).to_string()});
    let args = json!({"shop_id":"4","expected_policy_revision":"1","policy":policy,"command":command(&c,3).await?});
    let mut failures = vec![];
    for actor in [&op, &rex, &other] {
        let before = c.view_state().await?;
        let mut a = args.clone();
        a["command"] = command(&c, 1).await?;
        let r = call(&url, &c, actor, "set_assistant_permissions", a).await?;
        assert_eq!(r["succeeded"], false);
        assert_eq!(c.view_state().await?, before);
        failures.push(r);
    }
    let mut patches = vec![
        json!({"operator_account_id":other.id()}),
        json!({"expires_at_ns":null}),
        json!({"expires_at_ns":time.to_string()}),
        json!({"allowed_items":["herb"]}),
        json!({"allowed_items":["iron_tool","iron_tool"]}),
        json!({"allowed_items":[]}),
        json!({"min_price":"0"}),
        json!({"max_price":"101"}),
        json!({"min_price":"26"}),
        json!({"mode":"recommendations"}),
        json!({"mode":"off"}),
        json!({"quantity":"1"}),
        json!({"recipient":other.id()}),
        json!({"allowed_actions":["buy_from_merchant"]}),
    ];
    patches.push(json!({"min_price":5}));
    for patch in patches {
        let before = c.view_state().await?;
        let mut a = args.clone();
        for (k, v) in patch.as_object().unwrap() {
            a["policy"][k] = v.clone();
        }
        let r = call(&url, &c, &player, "set_assistant_permissions", a).await?;
        assert_eq!(r["succeeded"], false, "{patch}");
        assert_eq!(c.view_state().await?, before);
        failures.push(r);
    }
    let mut missing = args.clone();
    missing["policy"]
        .as_object_mut()
        .unwrap()
        .remove("operator_account_id");
    missing["policy"]["mode"] = json!("recommendations");
    let r = call(&url, &c, &player, "set_assistant_permissions", missing).await?;
    assert_eq!(r["succeeded"], false);
    failures.push(r);
    steps.push(call(&url, &c, &player, "set_assistant_permissions", args.clone()).await?);
    ensure!(
        steps.last().unwrap()["succeeded"] == true,
        "{}",
        steps.last().unwrap()["error"]
    );
    let active = view(&c, "get_assistant_policy", json!({"shop_id":"4"})).await?;
    assert_eq!(active["data"]["revision"], "2");
    // Exact replay, even after policy/command expiry, changes no state and emits no event.
    w.fast_forward(1200).await?;
    let before = c.view_state().await?;
    steps.push(call(&url, &c, &player, "set_assistant_permissions", args.clone()).await?);
    assert_eq!(steps.last().unwrap()["effect"]["data"]["replayed"], true);
    assert_eq!(c.view_state().await?, before);
    let off = json!({"mode":"off","operator_account_id":null,"allowed_items":[],"min_price":"1","max_price":"1","expires_at_ns":null});
    let revoke = json!({"shop_id":"4","expected_policy_revision":"2","policy":off,"command":command(&c,4).await?});
    let mut stale = revoke.clone();
    stale["expected_policy_revision"] = json!("1");
    let r = call(&url, &c, &player, "set_assistant_permissions", stale).await?;
    assert_eq!(r["succeeded"], false);
    failures.push(r);
    steps.push(
        call(
            &url,
            &c,
            &player,
            "set_assistant_permissions",
            revoke.clone(),
        )
        .await?,
    );
    steps.push(call(&url, &c, &player, "set_assistant_permissions", revoke).await?);
    let before = c.view_state().await?;
    let r = call(&url, &c, &player, "set_assistant_permissions", args).await?;
    assert_eq!(r["succeeded"], false);
    assert_eq!(c.view_state().await?, before);
    failures.push(r);
    // The owner can explicitly return to recommendations without an operator or expiry.
    let recommend = json!({"shop_id":"4","expected_policy_revision":"3","policy":{"mode":"recommendations","operator_account_id":null,"allowed_items":["iron_tool"],"min_price":"5","max_price":"25","expires_at_ns":null},"command":command(&c,5).await?});
    steps.push(call(&url, &c, &player, "set_assistant_permissions", recommend).await?);
    let recommend_policy = view(&c, "get_assistant_policy", json!({"shop_id":"4"})).await?;
    assert_eq!(recommend_policy["data"]["mode"], "recommendations");
    let disable = json!({"shop_id":"4","expected_policy_revision":"4","policy":off,"command":command(&c,6).await?});
    steps.push(call(&url, &c, &player, "set_assistant_permissions", disable).await?);
    let after = view(&c, "get_assistant_policy", json!({"shop_id":"4"})).await?;
    assert_eq!(after["data"]["mode"], "off");
    assert_eq!(after["data"]["revision"], "5");
    assert_eq!(
        ledger["data"],
        view(&c, "get_shop_inventory", json!({"shop_id":"4"})).await?["data"]
    );
    ensure!(
        steps.iter().all(|s| s["succeeded"] == true),
        "failed successful step"
    );
    let fixture = json!({"source":"actual disposable local WASM receipts; no Testnet deployment or AI calls","initial":initial,"active":active,"after":after,"ledger_before":ledger,"steps":steps,"failures":failures});
    std::fs::write(
        "../fixtures/chain/living-town-assistant-sandbox.json",
        serde_json::to_string_pretty(&fixture)? + "\n",
    )?;
    println!(
        "assistant permission sandbox: {} successes, {} rejected receipts",
        fixture["steps"].as_array().unwrap().len(),
        fixture["failures"].as_array().unwrap().len()
    );
    Ok(())
}
