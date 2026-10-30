use super::{coverage::reject, wasm};
use anyhow::Result;
use near_workspaces::Contract;
use serde_json::{Value, json};

async fn market(contract: &Contract) -> Result<Value> {
    Ok(contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?)
}

// Distinct counterparties submit concurrently, so neither nonce ordering nor
// a shared controller action sequence can mask competing economic claims.
#[tokio::test]
async fn concurrent_offers_cannot_double_spend_shared_gold_or_stock() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    for stock_case in [false, true] {
        let contract = worker.dev_deploy(&wasm()?).await?;
        let rex = worker.dev_create_account().await?;
        let luna = worker.dev_create_account().await?;
        let bolt = worker.dev_create_account().await?;
        let accounts = [&rex, &luna, &bolt];
        contract.call("initialize_market").args_json(json!({"owner_account_id":contract.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}})).transact().await?.into_result()?;
        let seed = market(&contract).await?;
        let expiry = seed["block_timestamp_ns"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            + 500_000_000_000;
        let (proposer, caller, buyers, sellers, quantity, total) = if stock_case {
            ("luna", &luna, ["rex", "bolt"], ["luna", "luna"], "8", "8")
        } else {
            ("rex", &rex, ["rex", "rex"], ["luna", "bolt"], "2", "100")
        };
        for index in 0..2 {
            caller.call(contract.id(), "propose_trade").args_json(json!({"proposer":proposer,"buyer":buyers[index],"seller":sellers[index],"resource":"crystal","quantity":quantity,"total_price":total,"expires_at_ns":expiry.to_string(),"action_id":(index+1).to_string()})).transact().await?.into_result()?;
        }
        let before = market(&contract).await?;
        // Proposals do not reserve or transfer either shared asset.
        for index in 0..3 {
            for field in ["gold", "inventory", "listings"] {
                assert_eq!(
                    before["data"]["merchants"][index][field],
                    seed["data"]["merchants"][index][field]
                );
            }
        }
        let accepters = if stock_case {
            [&rex, &bolt]
        } else {
            [&luna, &bolt]
        };
        let (a, b) = tokio::join!(
            accepters[0]
                .call(contract.id(), "accept_trade")
                .args_json(json!({"offer_id":"1","action_id":"1"}))
                .transact(),
            accepters[1]
                .call(contract.id(), "accept_trade")
                .args_json(json!({"offer_id":"2","action_id":"1"}))
                .transact(),
        );
        let outcomes = [a?, b?];
        assert_eq!(outcomes.iter().filter(|r| r.is_success()).count(), 1);
        let winner = outcomes.iter().position(|r| r.is_success()).unwrap();
        let loser = 1 - winner;
        let code = if stock_case {
            "BB:E_INSUFFICIENT_STOCK"
        } else {
            "BB:E_INSUFFICIENT_GOLD"
        };
        for (index, outcome) in outcomes.into_iter().enumerate() {
            if index == winner {
                let success = outcome.into_result()?;
                let result: Value = success.json()?;
                super::events::assert_event(
                    &success,
                    "accept_trade",
                    accepters[index].id().as_str(),
                    &result,
                )?;
                assert_eq!(
                    result["data"]["trade"]["offer_id"],
                    (winner + 1).to_string()
                );
                assert_eq!(result["data"]["trade"]["total_price"], total);
                assert_eq!(result["data"]["trade"]["quantity"], quantity);
            } else {
                assert!(outcome.logs().is_empty());
                assert!(
                    outcome
                        .into_result()
                        .unwrap_err()
                        .to_string()
                        .contains(code)
                );
            }
        }
        let after = market(&contract).await?;
        assert_eq!(after["market_revision"], "4");
        assert_eq!(after["data"]["next_trade_id"], "2");
        assert_eq!(after["data"]["total_issued_gold"], "550");
        let buyer = if stock_case && winner == 1 { 2 } else { 0 };
        let seller = if stock_case || winner == 0 { 1 } else { 2 };
        for index in 0..3 {
            let old = &seed["data"]["merchants"][index];
            let new = &after["data"]["merchants"][index];
            let gold = old["gold"].as_str().unwrap().parse::<u64>()?;
            let crystals = old["inventory"]["crystal"]
                .as_str()
                .unwrap()
                .parse::<u64>()?;
            let price = total.parse::<u64>()?;
            let quantity = quantity.parse::<u64>()?;
            let expected_gold = if index == buyer {
                gold - price
            } else if index == seller {
                gold + price
            } else {
                gold
            };
            let expected_stock = if index == buyer {
                crystals + quantity
            } else if index == seller {
                crystals - quantity
            } else {
                crystals
            };
            assert_eq!(new["gold"], expected_gold.to_string());
            assert_eq!(new["inventory"]["crystal"], expected_stock.to_string());
            for resource in ["wood", "herb", "iron"] {
                assert_eq!(new["inventory"][resource], old["inventory"][resource]);
            }
        }
        // Rejections must preserve the full public ledger and raw storage.
        reject(
            &contract,
            &accounts,
            accepters[loser],
            "accept_trade",
            json!({"offer_id":(loser+1).to_string(),"action_id":"1"}),
            code,
        )
        .await?;
        for action in ["1", "2"] {
            reject(
                &contract,
                &accounts,
                accepters[winner],
                "accept_trade",
                json!({"offer_id":(winner+1).to_string(),"action_id":action}),
                "BB:E_OFFER_ACCEPTED",
            )
            .await?;
        }
        let pending: Value = contract
            .view("get_offer")
            .args_json(json!({"offer_id":(loser+1).to_string()}))
            .await?
            .json()?;
        assert_eq!(pending["data"]["offer"]["status"], "pending");
        // The failed acceptance did not consume its action ID; use it to
        // propose a fresh valid offer, then reject reuse with changed terms.
        let loser_id = if stock_case {
            buyers[loser]
        } else {
            sellers[loser]
        };
        let retry_buyer = if loser_id == "luna" { "rex" } else { loser_id };
        let retry = json!({"proposer":loser_id,"buyer":retry_buyer,"seller":"luna","resource":"crystal","quantity":"1","total_price":"1","expires_at_ns":expiry.to_string(),"action_id":"1"});
        accepters[loser]
            .call(contract.id(), "propose_trade")
            .args_json(retry.clone())
            .transact()
            .await?
            .into_result()?;
        let mut replay = retry;
        replay["total_price"] = json!("2");
        reject(
            &contract,
            &accounts,
            accepters[loser],
            "propose_trade",
            replay,
            "BB:E_ACTION_USED",
        )
        .await?;
        println!(
            "ADVERSARIAL_RACE shared={} successful_settlements=1 rejected_retries=4",
            if stock_case { "stock" } else { "gold" }
        );
    }
    Ok(())
}
