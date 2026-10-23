use std::path::Path;

use anyhow::{Context, Result};
use serde_json::json;

#[tokio::test]
async fn market_initialization() -> Result<()> {
    let wasm_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/near/bot_bazaar_market.wasm");
    let wasm = std::fs::read(&wasm_path)
        .context("Build the contract with cargo near before running the sandbox test")?;

    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm).await?;

    let uninitialized = contract
        .view("get_name")
        .await
        .expect_err("An uninitialized contract must reject state reads");
    assert!(format!("{uninitialized:?}").contains("not initialized"));

    let other_account = worker.dev_create_account().await?;
    let unauthorized = other_account
        .call(contract.id(), "new")
        .args_json(json!({}))
        .transact()
        .await?;
    let unauthorized = unauthorized
        .into_result()
        .expect_err("Only the contract account may initialize the market");
    assert!(unauthorized.to_string().contains("private"));

    contract
        .call("new")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;

    let name: String = contract.view("get_name").await?.json()?;
    assert_eq!(name, "Bot Bazaar");

    let repeated = contract.call("new").args_json(json!({})).transact().await?;
    let repeated = repeated
        .into_result()
        .expect_err("An initialized contract must reject a second initialization");
    assert!(repeated.to_string().contains("already been initialized"));

    let name_after_rejection: String = contract.view("get_name").await?.json()?;
    assert_eq!(name_after_rejection, "Bot Bazaar");

    Ok(())
}
