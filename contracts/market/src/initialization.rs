use near_sdk::{AccountId, near, serde::Deserialize, store::LookupMap};

use crate::state::*;

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MerchantControllers {
    pub rex: AccountId,
    pub luna: AccountId,
    pub bolt: AccountId,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct InitializationArgs {
    pub owner_account_id: AccountId,
    pub merchant_controllers: MerchantControllers,
}

pub(crate) fn parse_initialization_input(input: &[u8]) -> Option<InitializationArgs> {
    let value: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(input).ok()?;
    if !value.is_object() || !value.get("merchant_controllers")?.is_object() {
        return None;
    }
    near_sdk::serde_json::from_slice(input).ok()
}

fn merchant(
    merchant_id: MerchantId,
    controller_account_id: AccountId,
    gold: u64,
    inventory: [u64; 4],
    terms: [(u64, u64); 4],
) -> Result<Merchant, StateError> {
    let inventory = Inventory::new(inventory)?;
    let [crystal, wood, herb, iron] =
        terms.map(|(price, quantity)| Listing::new(price, quantity, quantity > 0));
    let listings = [crystal?, wood?, herb?, iron?];
    for resource in Resource::ALL {
        if listings[resource.index()].quantity > inventory.amount(resource) {
            return Err(StateError::InvalidListing);
        }
    }
    Ok(Merchant {
        merchant_id,
        controller_account_id,
        balances: Balances::new(gold, inventory)?,
        listings,
        actions: ActionSequence::default(),
        pending_offer_count: 0,
    })
}

pub(crate) fn initialized_state(
    owner_account_id: AccountId,
    controllers: MerchantControllers,
    contract_account_id: &AccountId,
) -> Result<MarketState, StateError> {
    let accounts = [&controllers.rex, &controllers.luna, &controllers.bolt];
    for (index, account) in accounts.iter().enumerate() {
        if **account == owner_account_id
            || *account == contract_account_id
            || accounts[..index].contains(account)
        {
            return Err(StateError::InvalidControllers);
        }
    }
    let merchants = [
        merchant(
            MerchantId::Rex,
            controllers.rex,
            180,
            [15, 4, 2, 10],
            [(4, 15), (3, 2), (4, 0), (5, 6)],
        )?,
        merchant(
            MerchantId::Luna,
            controllers.luna,
            220,
            [12, 3, 20, 2],
            [(6, 8), (3, 1), (3, 12), (6, 0)],
        )?,
        merchant(
            MerchantId::Bolt,
            controllers.bolt,
            150,
            [2, 18, 4, 12],
            [(7, 0), (2, 10), (4, 2), (5, 6)],
        )?,
    ];
    let mut total_issued_gold = 0;
    let mut resource_supply = Inventory::default();
    for merchant in &merchants {
        total_issued_gold = checked_credit(total_issued_gold, merchant.balances.gold(), u64::MAX)?;
        for resource in Resource::ALL {
            resource_supply.credit(resource, merchant.balances.inventory.amount(resource))?;
        }
    }
    Ok(MarketState {
        owner_account_id,
        paused: false,
        registered_player_count: 0,
        total_issued_gold,
        resource_supply,
        merchants,
        players: LookupMap::new(StorageKey::Players),
        offers: LookupMap::new(StorageKey::Offers),
        trades: LookupMap::new(StorageKey::Trades),
        offer_ids: IdSequence::default(),
        trade_ids: IdSequence::default(),
        market_revision: 1,
        offers_pruned_through: 0,
        trades_pruned_through: 0,
        pending_offer_ids: [None; MAX_PENDING_OFFERS],
        terminal_offer_ids: RetainedIds::default(),
        trade_history_ids: RetainedIds::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, json};

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn controllers() -> MerchantControllers {
        MerchantControllers {
            rex: account("rex.testnet"),
            luna: account("luna.testnet"),
            bolt: account("bolt.testnet"),
        }
    }

    #[test]
    fn seed_matches_all_economy_rows_and_initial_counters() {
        let state = initialized_state(
            account("owner.testnet"),
            controllers(),
            &account("market.testnet"),
        )
        .unwrap();
        assert!(!state.paused);
        assert_eq!(state.owner_account_id, account("owner.testnet"));
        assert_eq!(state.registered_player_count, 0);
        assert_eq!(state.total_issued_gold, 550);
        assert_eq!(state.market_revision, 1);
        assert_eq!(state.offer_ids.next_id(), 1);
        assert_eq!(state.trade_ids.next_id(), 1);
        assert_eq!(state.offers_pruned_through, 0);
        assert_eq!(state.trades_pruned_through, 0);
        assert!(state.pending_offer_ids.iter().all(Option::is_none));
        assert!(state.terminal_offer_ids.slots.iter().all(Option::is_none));
        assert!(state.trade_history_ids.slots.iter().all(Option::is_none));
        assert_eq!(state.terminal_offer_ids.count, 0);
        assert_eq!(state.trade_history_ids.count, 0);
        let gold = [180, 220, 150];
        let inventory = [[15, 4, 2, 10], [12, 3, 20, 2], [2, 18, 4, 12]];
        let prices = [[4, 3, 4, 5], [6, 3, 3, 6], [7, 2, 4, 5]];
        let quantities = [[15, 2, 0, 6], [8, 1, 12, 0], [0, 10, 2, 6]];
        for id in MerchantId::ALL {
            let index = id.index();
            let merchant = &state.merchants[index];
            assert_eq!(merchant.merchant_id, id);
            assert_eq!(merchant.balances.gold(), gold[index]);
            assert_eq!(merchant.actions.last_action_id(), 0);
            assert_eq!(merchant.actions.last_action(), None);
            assert_eq!(merchant.pending_offer_count, 0);
            for resource in Resource::ALL {
                let slot = resource.index();
                assert_eq!(
                    merchant.balances.inventory.amount(resource),
                    inventory[index][slot]
                );
                assert_eq!(
                    merchant.listings[slot],
                    Listing::new(
                        prices[index][slot],
                        quantities[index][slot],
                        quantities[index][slot] > 0
                    )
                    .unwrap()
                );
                assert_eq!(
                    state.resource_supply.amount(resource),
                    [29, 25, 26, 24][slot]
                );
            }
        }
    }

    #[test]
    fn controller_mapping_is_distinct_and_excludes_owner_and_contract() {
        let owner = account("owner.testnet");
        let contract = account("market.testnet");
        for index in 0..3 {
            for reserved in [&owner, &contract] {
                let mut ids = controllers();
                match index {
                    0 => ids.rex = reserved.clone(),
                    1 => ids.luna = reserved.clone(),
                    _ => ids.bolt = reserved.clone(),
                }
                assert!(matches!(
                    initialized_state(owner.clone(), ids, &contract),
                    Err(StateError::InvalidControllers)
                ));
            }
        }
        for pair in [(0, 1), (0, 2), (1, 2)] {
            let mut ids = [
                account("rex.testnet"),
                account("luna.testnet"),
                account("bolt.testnet"),
            ];
            ids[pair.1] = ids[pair.0].clone();
            let [rex, luna, bolt] = ids;
            assert!(matches!(
                initialized_state(
                    owner.clone(),
                    MerchantControllers { rex, luna, bolt },
                    &contract
                ),
                Err(StateError::InvalidControllers)
            ));
        }
        assert!(initialized_state(contract.clone(), controllers(), &contract).is_ok());
    }

    #[test]
    fn initialization_input_rejects_unknown_missing_and_malformed_fields() {
        let valid = json!({ "owner_account_id": "owner.testnet", "merchant_controllers": { "rex": "rex.testnet", "luna": "luna.testnet", "bolt": "bolt.testnet" } });
        assert!(parse_initialization_input(&serde_json::to_vec(&valid).unwrap()).is_some());
        let mut cases = Vec::new();
        let mut input = valid.clone();
        input["gold"] = json!(999);
        cases.push(input);
        let mut input = valid.clone();
        input["merchant_controllers"]["extra"] = json!("extra.testnet");
        cases.push(input);
        let mut input = valid.clone();
        input.as_object_mut().unwrap().remove("owner_account_id");
        cases.push(input);
        let mut input = valid.clone();
        input["merchant_controllers"]
            .as_object_mut()
            .unwrap()
            .remove("bolt");
        cases.push(input);
        let mut input = valid.clone();
        input["owner_account_id"] = json!("INVALID!");
        cases.push(input);
        let mut input = valid.clone();
        input["merchant_controllers"]["rex"] = json!(null);
        cases.push(input);
        cases.push(json!([
            "owner.testnet",
            valid["merchant_controllers"].clone()
        ]));
        let mut input = valid.clone();
        input["merchant_controllers"] = json!(["rex.testnet", "luna.testnet", "bolt.testnet"]);
        cases.push(input);
        for input in cases {
            assert!(parse_initialization_input(&serde_json::to_vec(&input).unwrap()).is_none());
        }
        assert!(parse_initialization_input(br#"{"owner_account_id":"owner.testnet","owner_account_id":"other.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"}}"#).is_none());
    }
}
