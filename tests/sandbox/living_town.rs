use anyhow::{Context, Result};
use near_sdk::serde_json::{self, Value, json};
use std::path::Path;
mod living_town_adapter;
mod living_town_adversarial;
mod living_town_assistant;
mod living_town_completion;
mod living_town_customers;
mod living_town_listings;
mod living_town_offers;
mod living_town_ownership;
mod living_town_production;
mod living_town_purchases;
mod living_town_recipes;
mod living_town_reprice;
mod living_town_sales_races;
mod living_town_settlement;
mod living_town_upgrade;

fn wasm() -> Result<Vec<u8>> {
    std::fs::read(Path::new(
        "../../target/near/living-town/bot_bazaar_living_town.wasm",
    ))
    .context("Build V2 with corepack pnpm build:contract:v2; never substitute the V1 artifact")
}
// Regression runs preserve reviewed source fixtures. New disposable receipts
// are retained in the toolchain's target volume for deliberate review/promotion.
fn save_capture(filename: &str, value: &Value) -> Result<()> {
    let directory = Path::new("../../target/living-town-captures");
    std::fs::create_dir_all(directory)?;
    std::fs::write(
        directory.join(filename),
        serde_json::to_string_pretty(value)? + "\n",
    )?;
    Ok(())
}
// Fast-forward counts blocks, not seconds. Observe chain time before acting.
async fn advance_to(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    contract: &near_workspaces::Contract,
    target_ns: u64,
) -> Result<()> {
    for _ in 0..10 {
        let town = living_town_production::view(contract, "get_town", json!({})).await?;
        let now = town["block_timestamp_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        if now >= target_ns {
            return Ok(());
        }
        worker.fast_forward(1000).await?;
    }
    anyhow::bail!("sandbox chain did not reach the requested timestamp")
}
async fn advance_epoch(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    contract: &near_workspaces::Contract,
) -> Result<()> {
    let town = living_town_production::view(contract, "get_town", json!({})).await?;
    let genesis = town["data"]["genesis_time_ns"]
        .as_str()
        .unwrap()
        .parse::<u64>()?;
    let epoch = town["data"]["epoch"].as_str().unwrap().parse::<u64>()?;
    let target = genesis + (epoch + 1) * 60_000_000_000;
    // Land near the epoch's beginning so same-epoch replay assertions have
    // headroom for several actual transactions before the next boundary.
    for _ in 0..200 {
        let town = living_town_production::view(contract, "get_town", json!({})).await?;
        let now = town["block_timestamp_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?;
        if now >= target {
            return Ok(());
        }
        worker.fast_forward(10).await?;
    }
    anyhow::bail!("sandbox chain did not reach the next epoch")
}
fn canonical(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<_> = fields.keys().collect();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical(&fields[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => value.to_string(),
    }
}
#[tokio::test]
async fn isolated_v2_foundation_pins_versions_six_items_config_and_authority() -> Result<()> {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    let cfg: Value = serde_json::from_str(include_str!("../../config/living-town-v1.json"))?;
    let digest: String = near_sdk::env::sha256_array(canonical(&cfg).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let outsider = worker.dev_create_account().await?;
    let args = json!({"owner_account_id":contract.id(),"operator_account_id":"town-operator.testnet","merchant_controllers":{"rex":"town-rex.testnet","luna":"town-luna.testnet","bolt":"town-bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest});
    let before = worker.view_state(contract.id()).await?;
    let bad = outsider
        .call(contract.id(), "initialize_town")
        .args_json(args.clone())
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result();
    assert!(bad.unwrap_err().to_string().contains("LT:E_UNAUTHORIZED"));
    assert_eq!(worker.view_state(contract.id()).await?, before);
    for bad_args in [
        {
            let mut a = args.clone();
            a["config_sha256"] = json!("0".repeat(64));
            a
        },
        {
            let mut a = args.clone();
            a["operator_account_id"] = json!(contract.id());
            a
        },
        {
            let mut a = args.clone();
            a["network_genesis_hash"] = json!("wrong");
            a
        },
        {
            let mut a = args.clone();
            a["extra"] = json!(true);
            a
        },
    ] {
        assert!(
            contract
                .call("initialize_town")
                .args_json(bad_args)
                .gas(near_workspaces::types::Gas::from_tgas(100))
                .transact()
                .await?
                .into_result()
                .is_err()
        );
        assert_eq!(worker.view_state(contract.id()).await?, before);
    }
    let initialized = contract
        .call("initialize_town")
        .args_json(args.clone())
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(initialized.raw_bytes()?.is_empty());
    let logs = initialized.logs();
    assert_eq!(logs.len(), 1);
    let event: Value = serde_json::from_str(
        logs[0]
            .strip_prefix("EVENT_JSON:")
            .context("V2 structured event")?,
    )?;
    assert_eq!(event["standard"], "bot_bazaar_living_town");
    let town: Value = contract
        .view("get_town")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(town["deployment"]["api_version"], "2.0.0");
    assert_eq!(town["deployment"]["state_schema"], "1");
    assert_eq!(town["deployment"]["config_version"], "1");
    assert_eq!(town["deployment"]["config_sha256"], digest);
    assert_eq!(town["deployment"]["contract_id"], contract.id().as_str());
    assert_eq!(town["data"]["totals"]["initial_gold"], "700");
    assert_eq!(
        town["data"]["totals"]["seed_items"],
        json!({"crystal":"10","wood":"10","herb":"20","iron":"20","health_potion":"0","iron_tool":"0"})
    );
    for ledger in town["data"]["npc_ledgers"].as_array().unwrap() {
        for field in [
            "held",
            "available",
            "listing_reserved",
            "trade_reserved",
            "production_output_reserved",
            "trade_inbound_reserved",
        ] {
            assert_eq!(ledger["inventory"][field].as_object().unwrap().len(), 6);
            assert!(
                ledger["inventory"][field]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(Value::is_string)
            );
        }
    }
    let foundation: Value = contract
        .view("get_foundation")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(foundation["data"]["item_ids"], cfg["items"]);
    assert_eq!(
        foundation["data"]["owner_account_id"],
        contract.id().as_str()
    );
    let state = worker.view_state(contract.id()).await?;
    assert!(
        contract
            .call("initialize_town")
            .args_json(args)
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert!(
        contract
            .view("get_town")
            .args_json(json!({"unexpected":"1"}))
            .await
            .is_err()
    );
    assert!(
        contract
            .call("register_player")
            .args_json(json!({}))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()
            .is_err()
    );
    assert_eq!(worker.view_state(contract.id()).await?, state);
    println!("LIVING_TOWN_SNAPSHOT={town}");
    println!("LIVING_TOWN_FOUNDATION={foundation}");
    Ok(())
}

mod living_town_market_event;
mod living_town_sources;
