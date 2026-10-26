use super::wasm;
use anyhow::Result;
use near_workspaces::{Account, Contract};
use serde_json::{Value, json};

const MERCHANTS: [&str; 3] = ["rex", "luna", "bolt"];
const RESOURCES: [&str; 4] = ["crystal", "wood", "herb", "iron"];
const SUPPLY: [u128; 4] = [29, 25, 26, 24];

#[derive(Debug, PartialEq)]
struct Ledger {
    actors: Vec<[u64; 5]>,
    issued: u64,
    count: u64,
    next_trade: u64,
}

fn number(value: &Value) -> u64 {
    value.as_str().unwrap().parse().unwrap()
}

fn balances(value: &Value) -> [u64; 5] {
    let mut result = [0; 5];
    result[0] = number(&value["gold"]);
    for (index, resource) in RESOURCES.into_iter().enumerate() {
        result[index + 1] = number(&value["inventory"][resource]);
    }
    result
}

async fn state(contract: &Contract) -> Result<Value> {
    Ok(contract
        .view("get_market_state")
        .args_json(json!({}))
        .await?
        .json()?)
}

async fn audit(contract: &Contract, players: &[&Account]) -> Result<Ledger> {
    let market = state(contract).await?;
    let data = &market["data"];
    let mut actors = Vec::new();
    for (index, merchant) in data["merchants"].as_array().unwrap().iter().enumerate() {
        assert_eq!(merchant["merchant_id"], MERCHANTS[index]);
        actors.push(balances(merchant));
    }
    assert_eq!(actors.len(), 3);
    for player in players {
        let view: Value = contract
            .view("get_player")
            .args_json(json!({"account_id":player.id()}))
            .await?
            .json()?;
        assert_eq!(view["market_revision"], market["market_revision"]);
        assert_eq!(view["data"]["account_id"], player.id().as_str());
        actors.push(balances(&view["data"]));
    }
    let count = number(&data["registered_player_count"]);
    let issued = number(&data["total_issued_gold"]);
    assert_eq!(count, players.len() as u64);
    let expected = 550 + 100 * players.len() as u128;
    assert_eq!(
        actors.iter().map(|a| u128::from(a[0])).sum::<u128>(),
        expected
    );
    assert_eq!(u128::from(issued), expected);
    for (index, (resource, expected)) in RESOURCES.into_iter().zip(SUPPLY).enumerate() {
        assert_eq!(
            actors
                .iter()
                .map(|a| u128::from(a[index + 1]))
                .sum::<u128>(),
            expected
        );
        assert_eq!(
            u128::from(number(&data["resource_supply"][resource])),
            expected
        );
    }
    Ok(Ledger {
        actors,
        count,
        issued,
        next_trade: number(&data["next_trade_id"]),
    })
}

fn transfer(
    before: &Ledger,
    after: &Ledger,
    buyer: usize,
    seller: usize,
    resource: usize,
    quantity: u64,
    total: u64,
) {
    assert_eq!(before.issued, after.issued);
    assert_eq!(before.count, after.count);
    assert_eq!(before.next_trade + 1, after.next_trade);
    assert_eq!(before.actors.len(), after.actors.len());
    for (actor, (old, new)) in before.actors.iter().zip(&after.actors).enumerate() {
        for (component, value) in old.iter().copied().enumerate() {
            let expected = if component == 0 && actor == buyer {
                value - total
            } else if component == 0 && actor == seller {
                value + total
            } else if component == resource + 1 && actor == buyer {
                value + quantity
            } else if component == resource + 1 && actor == seller {
                value - quantity
            } else {
                value
            };
            assert_eq!(new[component], expected);
        }
    }
}

async fn call(contract: &Contract, caller: &Account, method: &str, args: Value) -> Result<Value> {
    let result: Value = caller
        .call(contract.id(), method)
        .args_json(args)
        .transact()
        .await?
        .into_result()?
        .json()?;
    Ok(result)
}

async fn register(contract: &Contract, existing: &[&Account], player: &Account) -> Result<Ledger> {
    let before = audit(contract, existing).await?;
    call(contract, player, "register_player", json!({})).await?;
    let mut players = existing.to_vec();
    players.push(player);
    let after = audit(contract, &players).await?;
    assert_eq!(
        &after.actors[..before.actors.len()],
        before.actors.as_slice()
    );
    assert_eq!(after.actors.last().unwrap(), &[100, 0, 0, 0, 0]);
    assert_eq!(after.issued, before.issued + 100);
    assert_eq!(after.count, before.count + 1);
    assert_eq!(after.next_trade, before.next_trade);
    Ok(after)
}

#[tokio::test]
async fn public_economy_conserves_all_resources_and_separates_grants_from_trading() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let rex = worker.dev_create_account().await?;
    let luna = worker.dev_create_account().await?;
    let bolt = worker.dev_create_account().await?;
    let first = worker.dev_create_account().await?;
    let second = worker.dev_create_account().await?;
    let third = worker.dev_create_account().await?;
    let controllers = [&rex, &luna, &bolt];
    let players = [&first, &second];
    contract.call("initialize_market").args_json(json!({"owner_account_id":owner.id(),"merchant_controllers":{"rex":rex.id(),"luna":luna.id(),"bolt":bolt.id()}})).transact().await?.into_result()?;
    let seed = audit(&contract, &[]).await?;
    assert_eq!(seed.issued, 550);
    register(&contract, &[], &first).await?;
    register(&contract, &[&first], &second).await?;
    let before = audit(&contract, &players).await?;
    let raw = contract.view_state().await?;
    let duplicate = first
        .call(contract.id(), "register_player")
        .args_json(json!({}))
        .transact()
        .await?;
    assert!(
        duplicate
            .into_result()
            .unwrap_err()
            .to_string()
            .contains("BB:E_ALREADY_REGISTERED")
    );
    assert_eq!(audit(&contract, &players).await?, before);
    assert_eq!(contract.view_state().await?, raw);
    for (player, merchant, resource, quantity, price) in [
        (0, 0, 0, 12, 4),
        (1, 2, 1, 2, 2),
        (0, 1, 2, 3, 3),
        (1, 2, 3, 1, 5),
    ] {
        let before = audit(&contract, &players).await?;
        let total = quantity * price;
        let result=call(&contract,players[player],"buy_from_merchant",json!({"merchant_id":MERCHANTS[merchant],"resource":RESOURCES[resource],"quantity":quantity.to_string(),"max_total_price":total.to_string(),"listing_version":"1"})).await?;
        assert_eq!(result["data"]["kind"], "player_purchase");
        assert_eq!(number(&result["data"]["quantity"]), quantity);
        assert_eq!(number(&result["data"]["total_price"]), total);
        transfer(
            &before,
            &audit(&contract, &players).await?,
            3 + player,
            merchant,
            resource,
            quantity,
            total,
        );
    }
    for (buyer, seller, proposer, resource) in
        [(0, 1, 0, 0), (1, 2, 2, 1), (2, 1, 2, 2), (1, 0, 0, 3)]
    {
        let before = audit(&contract, &players).await?;
        let market = state(&contract).await?;
        let action = number(&market["data"]["merchants"][proposer]["last_action_id"]) + 1;
        let now = number(&market["block_timestamp_ns"]);
        let offered=call(&contract,controllers[proposer],"propose_trade",json!({"proposer":MERCHANTS[proposer],"buyer":MERCHANTS[buyer],"seller":MERCHANTS[seller],"resource":RESOURCES[resource],"quantity":"1","total_price":"2","expires_at_ns":(now+500_000_000_000).to_string(),"action_id":action.to_string()})).await?;
        assert_eq!(audit(&contract, &players).await?, before);
        let counterparty = if proposer == buyer { seller } else { buyer };
        let market = state(&contract).await?;
        let action = number(&market["data"]["merchants"][counterparty]["last_action_id"]) + 1;
        let accepted = call(
            &contract,
            controllers[counterparty],
            "accept_trade",
            json!({"offer_id":offered["data"]["offer"]["offer_id"],"action_id":action.to_string()}),
        )
        .await?;
        assert_eq!(accepted["data"]["trade"]["kind"], "merchant_trade");
        assert_eq!(accepted["data"]["trade"]["resource"], RESOURCES[resource]);
        assert_eq!(accepted["data"]["trade"]["total_price"], "2");
        assert_eq!(accepted["data"]["trade"]["quantity"], "1");
        transfer(
            &before,
            &audit(&contract, &players).await?,
            buyer,
            seller,
            resource,
            1,
            2,
        );
    }
    let before = register(&contract, &players, &third).await?;
    let players = [&first, &second, &third];
    let current = state(&contract).await?;
    let action = number(&current["data"]["merchants"][0]["last_action_id"]) + 1;
    let listing = &current["data"]["merchants"][0]["listings"][0];
    call(&contract,&rex,"set_listing",json!({"merchant_id":"rex","resource":"crystal","unit_price":"5","quantity":"1","active":true,"expected_version":listing["version"],"action_id":action.to_string()})).await?;
    assert_eq!(audit(&contract, &players).await?, before);
    let now = number(&current["block_timestamp_ns"]);
    let offer=call(&contract,&rex,"propose_trade",json!({"proposer":"rex","buyer":"rex","seller":"luna","resource":"crystal","quantity":"1","total_price":"2","expires_at_ns":(now+500_000_000_000).to_string(),"action_id":(action+1).to_string()})).await?;
    assert_eq!(audit(&contract, &players).await?, before);
    call(
        &contract,
        &rex,
        "cancel_trade",
        json!({"offer_id":offer["data"]["offer"]["offer_id"],"action_id":(action+2).to_string()}),
    )
    .await?;
    assert_eq!(audit(&contract, &players).await?, before);
    call(&contract, &owner, "pause_market", json!({})).await?;
    assert_eq!(audit(&contract, &players).await?, before);
    call(&contract, &owner, "resume_market", json!({})).await?;
    assert_eq!(audit(&contract, &players).await?, before);
    let history: Value = contract
        .view("get_recent_trades")
        .args_json(json!({"after_id":null,"limit":"50","expected_revision":null}))
        .await?
        .json()?;
    assert_eq!(history["data"]["items"].as_array().unwrap().len(), 8);
    assert_eq!(before.issued, 850);
    assert_eq!(before.next_trade, 9);
    println!(
        "ECONOMY seed=550 grants=3 issued=850 purchases=4 merchant_trades=4 resources=[29,25,26,24]"
    );
    Ok(())
}
