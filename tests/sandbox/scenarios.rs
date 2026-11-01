use anyhow::{Context, Result, ensure};
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

async fn market(contract: &Contract) -> Result<Value> {
    Ok(contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?)
}

async fn ledger(contract: &Contract, player: &Account) -> Result<Value> {
    let snapshot = market(contract).await?;
    let player: Value = contract
        .view("get_player")
        .args_json(json!({"account_id":player.id()}))
        .await?
        .json()?;
    let mut actors = snapshot["data"]["merchants"].as_array().unwrap().clone();
    actors.push(player["data"].clone());
    let mut totals = serde_json::Map::new();
    for resource in ["gold", "crystal", "wood", "herb", "iron"] {
        let sum: u128 = actors
            .iter()
            .map(|a| {
                let value = if resource == "gold" {
                    &a[resource]
                } else {
                    &a["inventory"][resource]
                };
                value.as_str().unwrap().parse::<u128>().unwrap()
            })
            .sum();
        totals.insert(resource.into(), json!(sum.to_string()));
    }
    ensure!(
        totals["gold"] == snapshot["data"]["total_issued_gold"],
        "gold conservation"
    );
    for resource in ["crystal", "wood", "herb", "iron"] {
        ensure!(
            totals[resource] == snapshot["data"]["resource_supply"][resource],
            "resource conservation"
        );
    }
    Ok(json!({"market":snapshot,"player":player,"totals":totals}))
}

async fn call(
    contract: &Contract,
    actor: &Account,
    method: &str,
    args: Value,
    steps: &mut Vec<Value>,
) -> Result<Value> {
    let outcome = actor
        .call(contract.id(), method)
        .args_json(args.clone())
        .max_gas()
        .transact()
        .await?;
    let transaction_hash = outcome.outcome().transaction_hash.to_string();
    let result: Value = outcome.into_result()?.json()?;
    steps.push(json!({"source":"sandbox_contract","signer":actor.id(),"method":method,"args":args,"transaction_hash":transaction_hash,"result":result}));
    let output = std::env::var("BAZAAR_SCENARIO_OUTPUT")?;
    let journal = Path::new(&output).with_file_name("controlled-transactions.ndjson");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal)?;
    writeln!(file, "{}", serde_json::to_string(steps.last().unwrap())?)?;
    file.sync_all()?;
    Ok(result)
}

async fn turn(
    contract: &Contract,
    merchant: &str,
    phase: &str,
    offers: &[Value],
    candidate: Option<&Value>,
    remaining: usize,
) -> Result<Value> {
    let snapshot = market(contract).await?;
    let input = json!({"merchantId":merchant,"phase":phase,"mutationsRemaining":remaining,"candidate":candidate,"state":{
        "market":snapshot,"block":{"hash":null,"height":snapshot["block_height"],"timestampNs":snapshot["block_timestamp_ns"]},
        "offers":offers,"trades":[],"tradeCursor":"0","mode":"initial","observedAt":snapshot["block_timestamp_ns"].as_str().unwrap().parse::<u64>()?/1_000_000
    }});
    // No real network adapter or credentials enter the controlled provider process.
    let bridge = std::env::var("BAZAAR_SCENARIO_BRIDGE").context("run the scenario image")?;
    let mut child = Command::new("node")
        .arg(bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&input)?.as_bytes())?;
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "controlled schema/policy bridge rejected the turn"
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[tokio::test]
async fn controlled_sandbox_crystal_shortage() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/near/bot_bazaar_market.wasm"),
    )?;
    let contract = worker.dev_deploy(&wasm).await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    contract.call("initialize_market").args_json(json!({"owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}})).transact().await?.into_result()?;
    let mut steps = Vec::new();
    call(&contract, &player, "register_player", json!({}), &mut steps).await?;
    let before = ledger(&contract, &player).await?;
    call(&contract, &player, "buy_from_merchant", json!({"merchant_id":"rex","resource":"crystal","quantity":"12","max_total_price":"48","listing_version":"1"}), &mut steps).await?;
    let shortage = ledger(&contract, &player).await?;
    ensure!(
        shortage["market"]["data"]["merchants"][0]["inventory"]["crystal"] == "3",
        "shortage trigger"
    );
    let mut decisions = Vec::new();
    let mut offers = Vec::new();
    let mut mutation_count = 0;
    for (name, phase, actor) in [
        ("rex", "decision", &rex),
        ("luna", "decision", &luna),
        ("rex", "followup", &rex),
        ("luna", "followup", &luna),
        ("bolt", "decision", &bolt),
    ] {
        let selected = turn(&contract, name, phase, &offers, None, 8 - mutation_count).await?;
        decisions.push(selected.clone());
        for prep in selected["plan"]["preparations"].as_array().unwrap() {
            call(
                &contract,
                actor,
                prep["method"].as_str().unwrap(),
                prep["args"].clone(),
                &mut steps,
            )
            .await?;
            mutation_count += 1;
        }
        let refreshed = turn(
            &contract,
            name,
            phase,
            &offers,
            Some(&selected["candidate"]),
            8 - mutation_count,
        )
        .await?;
        ensure!(
            refreshed["plan"]["preparations"]
                .as_array()
                .unwrap()
                .is_empty(),
            "prerequisites not resolved"
        );
        let action = &refreshed["plan"]["action"];
        if action["method"] != "hold" {
            let result = call(
                &contract,
                actor,
                action["method"].as_str().unwrap(),
                action["args"].clone(),
                &mut steps,
            )
            .await?;
            mutation_count += 1;
            if !result["data"]["offer"].is_null() {
                offers = vec![result["data"]["offer"].clone()];
            }
        }
    }
    let after = ledger(&contract, &player).await?;
    ensure!(before["totals"] == after["totals"], "scenario conservation");
    let merchants = &after["market"]["data"]["merchants"];
    for resource in ["wood", "herb", "iron"] {
        for index in 0..3 {
            ensure!(
                merchants[index]["inventory"][resource]
                    == before["market"]["data"]["merchants"][index]["inventory"][resource],
                "unrelated merchant resource changed"
            );
        }
        ensure!(
            after["player"]["data"]["inventory"][resource]
                == before["player"]["data"]["inventory"][resource],
            "unrelated player resource changed"
        );
    }
    ensure!(
        merchants[0]["inventory"]["crystal"] == "7" && merchants[0]["gold"] == "204",
        "Rex exact settlement delta"
    );
    ensure!(
        merchants[1]["inventory"]["crystal"] == "8" && merchants[1]["gold"] == "244",
        "Luna exact settlement delta"
    );
    ensure!(
        merchants[2] == before["market"]["data"]["merchants"][2],
        "Bolt did not mutate"
    );
    ensure!(
        after["player"]["data"]["gold"] == "52"
            && after["player"]["data"]["inventory"]["crystal"] == "12",
        "player exact delta"
    );
    ensure!(mutation_count == 5, "bounded controller mutations");
    ensure!(
        merchants[0]["last_action_id"] == "3" && merchants[1]["last_action_id"] == "2",
        "exact controller action sequences"
    );
    ensure!(offers[0]["status"] == "accepted", "offer settled");
    let listing = merchants[0]["listings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["resource"] == "crystal")
        .unwrap();
    ensure!(
        listing["unit_price"] == "7" && listing["quantity"] == "4" && listing["active"] == true,
        "shortage relisting"
    );
    let output = std::env::var("BAZAAR_SCENARIO_OUTPUT").context("output path required")?;
    let report = json!({"schema":"bot-bazaar-scenario-v1","scenario":"controlled-sandbox-crystal-shortage","mode":"controlled_sandbox","label":"Controlled sandbox test data","provider":"controlled-fixture","liveAiEvidence":false,"network":"sandbox","status":"passed","before":before,"shortage":shortage,"after":after,"decisions":decisions,"transactions":steps,"assertions":{"conservation":true,"exact_deltas":true,"mutation_count":mutation_count,"real_provider_acceptance":false}});
    std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    Ok(())
}
