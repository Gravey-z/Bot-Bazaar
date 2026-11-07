use near_sdk::serde::{Deserialize, de::DeserializeOwned};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, PanicOnDefault, env, near, require};

mod assistant;
mod customers;
mod listings;
mod market_events;
mod ownership;
mod production;
mod purchases;
mod recipes;
mod sources;
pub use ownership::{Command, Decimal};
use ownership::{CommandRecord, Player, Shop};
pub use purchases::MerchantId;
pub use recipes::{ProductionTerms, Recipe, RecipeId};

const CONFIG: &str = include_str!("../../../config/living-town-v1.json");
pub const ITEM_IDS: [&str; 6] = [
    "crystal",
    "wood",
    "herb",
    "iron",
    "health_potion",
    "iron_tool",
];
const MERCHANTS: [&str; 3] = ["rex", "luna", "bolt"];

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Item {
    Crystal,
    Wood,
    Herb,
    Iron,
    HealthPotion,
    IronTool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Inventory {
    quantities: [u64; 6],
}
impl Inventory {
    pub fn new(quantities: [u64; 6]) -> Self {
        require!(quantities.iter().all(|q| *q <= 1000), "LT:E_BALANCE_CAP");
        Self { quantities }
    }
    pub fn view(&self) -> Value {
        Value::Object(
            ITEM_IDS
                .iter()
                .zip(self.quantities)
                .map(|(item, quantity)| ((*item).to_owned(), json!(quantity.to_string())))
                .collect(),
        )
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
struct Listing {
    id: u64,
    quantity: u64,
    unit_price: u64,
    revision: u64,
}
#[near(serializers = [borsh])]
#[derive(Clone)]
struct Npc {
    gold: u64,
    held: Inventory,
    listings: [Option<Listing>; 6],
    ledger_revision: u64,
    reservations: purchases::Reservations,
    production_revision: u64,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct Controllers {
    pub rex: AccountId,
    pub luna: AccountId,
    pub bolt: AccountId,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct InitArgs {
    owner_account_id: AccountId,
    merchant_controllers: Controllers,
    operator_account_id: AccountId,
    network_genesis_hash: String,
    config_sha256: String,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct EmptyArgs {}

fn input<T: DeserializeOwned>() -> T {
    let raw = env::input().unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"));
    require!(raw.len() <= 8192, "LT:E_INVALID_ARGUMENT");
    let shape: Value =
        serde_json::from_slice(&raw).unwrap_or_else(|_| env::panic_str("LT:E_INVALID_ARGUMENT"));
    require!(shape.is_object(), "LT:E_INVALID_ARGUMENT");
    serde_json::from_slice(&raw).unwrap_or_else(|_| env::panic_str("LT:E_INVALID_ARGUMENT"))
}
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<_> = fields.keys().collect();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key"),
                        canonical_json(&fields[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}
fn config() -> Value {
    serde_json::from_str(CONFIG).expect("embedded reviewed config")
}
fn config_digest() -> String {
    env::sha256_array(canonical_json(&config()).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_hash(value: &str) -> bool {
    if !(32..=44).contains(&value.len()) {
        return false;
    }
    let alphabet = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut bytes = [0_u8; 32];
    for ch in value.bytes() {
        let Some(index) = alphabet.iter().position(|v| *v == ch) else {
            return false;
        };
        let mut carry = index as u16;
        for byte in bytes.iter_mut().rev() {
            carry += u16::from(*byte) * 58;
            *byte = (carry & 255) as u8;
            carry >>= 8;
        }
        if carry != 0 {
            return false;
        }
    }
    value.bytes().take_while(|ch| *ch == b'1').count()
        + bytes.iter().skip_while(|b| **b == 0).count()
        == 32
}

// Development V2 root; never deserialize or upgrade V1 state with this crate.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct LivingTown {
    state_schema: u8,
    config_version: u64,
    config_sha256: String,
    genesis_hash: String,
    genesis_time_ns: u64,
    owner: AccountId,
    operator: AccountId,
    controllers: [AccountId; 3],
    npcs: [Npc; 3],
    paused: bool,
    market_revision: u64,
    registered_player_count: u64,
    issued_grants: u128,
    next_shop_id: u64,
    players: LookupMap<AccountId, Player>,
    shops: LookupMap<u64, Shop>,
    commands: LookupMap<String, CommandRecord>,
    next_job_id: u64,
    jobs: LookupMap<u64, production::Job>,
    active_jobs: LookupMap<u64, u64>,
    recipe_inputs_consumed: [u128; 6],
    completed_outputs: [u128; 6],
    completed_jobs: std::collections::VecDeque<u64>,
    pruned_jobs_through: u64,
    next_trade_id: u64,
    trades: LookupMap<u64, purchases::Trade>,
    next_listing_id: u64,
    listing_slots: LookupMap<(u64, u8), u64>,
    listing_index: LookupMap<u64, (u64, u8)>,
    player_listings: LookupMap<u64, Listing>,
    customer_pool: customers::Pool,
    customer_topups: u128,
    customer_consumed: [u128; 6],
    raw_epochs: [u64; 4],
    treasury_epochs: [u64; 3],
    supplied_items: [u128; 6],
    treasury_burns: u128,
    next_market_event_id: u64,
    market_events: std::collections::VecDeque<market_events::MarketEvent>,
}
impl LivingTown {
    fn assert_versions(&self) {
        require!(
            self.state_schema == 1 && self.config_version == 1,
            "LT:E_UNSUPPORTED_VERSION"
        );
        require!(self.config_sha256 == config_digest(), "LT:E_CONFIG_CHANGED");
    }
    fn deployment(&self) -> Value {
        json!({"network_id":"testnet","genesis_hash":self.genesis_hash,"contract_id":env::current_account_id(),"api_version":"2.0.0","state_schema":self.state_schema.to_string(),"command_schema":"1","config_version":self.config_version.to_string(),"config_sha256":self.config_sha256})
    }
    fn snapshot(&self, data: Value) -> Value {
        json!({"deployment":self.deployment(),"market_revision":self.market_revision.to_string(),"event_sequence":self.market_revision.to_string(),"block_height":env::block_height().to_string(),"block_timestamp_ns":env::block_timestamp().to_string(),"data":data})
    }
    fn town(&self) -> Value {
        let mut shops = Vec::new();
        let mut ledgers = Vec::new();
        for (index, npc) in self.npcs.iter().enumerate() {
            let owner = json!({"kind":"merchant","merchant_id":MERCHANTS[index]});
            shops.push(json!({"shop_id":(index+1).to_string(),"owner":owner,"name":(["Rex","Luna","Bolt"][index]),"revision":npc.production_revision.to_string(),"production_slots":"1","policy_revision":"1","created_at_ns":self.genesis_time_ns.to_string(),"ownership_command_sequence":null}));
            ledgers.push(purchases::npc_ledger(index, npc));
        }
        json!({"paused":self.paused,"registered_player_count":self.registered_player_count.to_string(),"epoch":((env::block_timestamp()-self.genesis_time_ns)/60_000_000_000).to_string(),"genesis_time_ns":self.genesis_time_ns.to_string(),"npc_shops":shops,"npc_ledgers":ledgers,"customer_pool":self.customer_pool.view(self.customer_epoch()),"totals":{"initial_gold":"700","player_grants":self.issued_grants.to_string(),"customer_topups":self.customer_topups.to_string(),"upgrade_burns":"0","treasury_burns":self.treasury_burns.to_string(),"seed_items":Inventory::new([10,10,20,20,0,0]).view(),"supplied_items":Value::Object(ITEM_IDS.iter().zip(self.supplied_items).map(|(k,v)|((*k).to_owned(),json!(v.to_string()))).collect()),"recipe_inputs_consumed":Value::Object(ITEM_IDS.iter().zip(self.recipe_inputs_consumed).map(|(k,v)|((*k).to_owned(),json!(v.to_string()))).collect()),"completed_outputs":Value::Object(ITEM_IDS.iter().zip(self.completed_outputs).map(|(k,v)|((*k).to_owned(),json!(v.to_string()))).collect()),"customer_consumed":Value::Object(ITEM_IDS.iter().zip(self.customer_consumed).map(|(k,v)|((*k).to_owned(),json!(v.to_string()))).collect())},"market_event":self.market_events.back().map(market_events::MarketEvent::view),"next_shop_id":self.next_shop_id.to_string(),"next_listing_id":self.next_listing_id.to_string(),"next_job_id":self.next_job_id.to_string(),"next_offer_id":"1","next_trade_id":self.next_trade_id.to_string(),"next_market_event_id":self.next_market_event_id.to_string(),"retained_events_from":"1","limits":config()["limits"]})
    }
}
#[near]
impl LivingTown {
    #[init]
    pub fn initialize_town(
        owner_account_id: AccountId,
        merchant_controllers: Controllers,
        operator_account_id: AccountId,
        network_genesis_hash: String,
        config_sha256: String,
    ) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "LT:E_UNAUTHORIZED"
        );
        let args: InitArgs = input();
        require!(
            args.owner_account_id == owner_account_id
                && args.operator_account_id == operator_account_id
                && args.network_genesis_hash == network_genesis_hash
                && args.config_sha256 == config_sha256
                && args.merchant_controllers.rex == merchant_controllers.rex
                && args.merchant_controllers.luna == merchant_controllers.luna
                && args.merchant_controllers.bolt == merchant_controllers.bolt,
            "LT:E_INVALID_ARGUMENT"
        );
        require!(config_sha256 == config_digest(), "LT:E_CONFIG_CHANGED");
        require!(valid_hash(&network_genesis_hash), "LT:E_INVALID_ARGUMENT");
        let controllers = [
            merchant_controllers.rex,
            merchant_controllers.luna,
            merchant_controllers.bolt,
        ];
        let mut roles = vec![owner_account_id.clone(), operator_account_id.clone()];
        roles.extend(controllers.iter().cloned());
        require!(
            roles
                .iter()
                .enumerate()
                .all(|(index, role)| !roles[..index].contains(role))
                && operator_account_id != env::current_account_id()
                && controllers
                    .iter()
                    .all(|id| *id != env::current_account_id()),
            "LT:E_INVALID_ROLES"
        );
        let cfg = config();
        let npcs = std::array::from_fn(|index| {
            let mut held = [0; 6];
            let mut listings: [Option<Listing>; 6] = std::array::from_fn(|_| None);
            for (slot, item) in ITEM_IDS[..4].iter().enumerate() {
                let row = &cfg["economy"]["materials"][item];
                if row["supplier"] == MERCHANTS[index] {
                    held[slot] = row["seed"]
                        .as_str()
                        .expect("seed")
                        .parse()
                        .expect("seed integer");
                    listings[slot] = Some(Listing {
                        id: slot as u64 + 1,
                        quantity: row["listed"]
                            .as_str()
                            .expect("listing")
                            .parse()
                            .expect("quantity"),
                        unit_price: row["price"]
                            .as_str()
                            .expect("price")
                            .parse()
                            .expect("price integer"),
                        revision: 1,
                    });
                }
            }
            Npc {
                gold: 200,
                held: Inventory::new(held),
                listings,
                ledger_revision: 1,
                reservations: purchases::Reservations::default(),
                production_revision: 1,
            }
        });
        let mut contract = Self {
            state_schema: 1,
            config_version: 1,
            config_sha256,
            genesis_hash: network_genesis_hash,
            genesis_time_ns: env::block_timestamp(),
            owner: owner_account_id,
            operator: operator_account_id,
            controllers,
            npcs,
            paused: false,
            market_revision: 1,
            registered_player_count: 0,
            issued_grants: 0,
            next_shop_id: 4,
            players: LookupMap::new(b"lt:v2:players:".to_vec()),
            shops: LookupMap::new(b"lt:v2:shops:".to_vec()),
            commands: LookupMap::new(b"lt:v2:principals:".to_vec()),
            next_job_id: 1,
            jobs: LookupMap::new(b"lt:v2:jobs:".to_vec()),
            active_jobs: LookupMap::new(b"lt:v2:active-jobs:".to_vec()),
            recipe_inputs_consumed: [0; 6],
            completed_outputs: [0; 6],
            completed_jobs: std::collections::VecDeque::new(),
            pruned_jobs_through: 0,
            next_trade_id: 1,
            trades: LookupMap::new(b"lt:v2:trades:".to_vec()),
            customer_pool: customers::Pool::initial(),
            customer_topups: 0,
            raw_epochs: [0; 4],
            treasury_epochs: [0; 3],
            supplied_items: [0; 6],
            treasury_burns: 0,
            next_market_event_id: 1,
            market_events: std::collections::VecDeque::new(),
            customer_consumed: [0; 6],
            next_listing_id: 5,
            listing_slots: LookupMap::new(b"lt:v2:listing-slots:".to_vec()),
            listing_index: LookupMap::new(b"lt:v2:listing-index:".to_vec()),
            player_listings: LookupMap::new(b"lt:v2:player-listings:".to_vec()),
        };
        for index in 0..3 {
            for slot in 0..6 {
                if let Some(listing) = &contract.npcs[index].listings[slot] {
                    let id = listing.id;
                    let key = (index as u64 + 1, slot as u8);
                    contract.listing_slots.insert(key, id);
                    contract.listing_index.insert(id, key);
                }
            }
        }
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({"standard":"bot_bazaar_living_town","version":"2.0.0","event":"town_initialized","data":[{"contract_id":env::current_account_id(),"config_version":"1","event_sequence":"1","market_revision":"1","block_height":env::block_height().to_string(),"block_timestamp_ns":env::block_timestamp().to_string(),"predecessor_account_id":env::predecessor_account_id(),"principal":null,"command_sequence":null,"payload_sha256":null,"outcome":{"kind":"town_initialized","town":contract.town()}}]})
        ));
        contract
    }
    pub fn get_town(&self) -> Value {
        let _: EmptyArgs = input();
        self.assert_versions();
        self.snapshot(self.town())
    }
    pub fn get_foundation(&self) -> Value {
        let _: EmptyArgs = input();
        self.assert_versions();
        self.snapshot(json!({"owner_account_id":self.owner,"operator_account_id":self.operator,"merchant_controllers":{"rex":self.controllers[0],"luna":self.controllers[1],"bolt":self.controllers[2]},"item_ids":ITEM_IDS,"supported_methods":["initialize_town","get_foundation","get_town","register_player","create_shop","rename_shop","get_player","get_shop","get_player_shops","get_command","buy_from_merchant","get_listings","get_trade","get_shop_inventory","get_recipes","start_production","get_production_jobs","complete_production","set_listing","cancel_listing","get_source_state","get_market_events","schedule_market_event","allocate_raw_supply","sweep_merchant_treasury","fund_customer_budget","settle_customer_purchase","get_assistant_policy","set_assistant_permissions","assistant_reprice"]}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn six_items_do_not_reinterpret_legacy_discriminants_or_four_slots() {
        assert_eq!(near_sdk::borsh::to_vec(&Item::Crystal).unwrap(), vec![0]);
        assert_eq!(near_sdk::borsh::to_vec(&Item::Iron).unwrap(), vec![3]);
        assert_eq!(
            near_sdk::borsh::to_vec(&Item::HealthPotion).unwrap(),
            vec![4]
        );
        assert_eq!(near_sdk::borsh::to_vec(&Item::IronTool).unwrap(), vec![5]);
        let inventory = Inventory::new([1, 2, 3, 4, 5, 6]);
        assert_eq!(near_sdk::borsh::to_vec(&inventory).unwrap().len(), 48);
        assert_eq!(inventory.view()["iron_tool"], "6");
        assert!(near_sdk::borsh::from_slice::<Inventory>(&[0; 32]).is_err());
    }
    #[test]
    fn canonical_command_matches_the_typescript_golden_domain() {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        let value: Value = serde_json::from_str(r#"{"api_version":"2.0.0","args":{"command":{"config_version":"1","sequence":"2","valid_until_ns":"600000000000"},"name":"Herb Shop"},"contract_id":"living-town-example.testnet","domain":"bot-bazaar:living-town:command:1","genesis_hash":"11111111111111111111111111111111","method":"create_shop","network_id":"testnet","predecessor_account_id":"player-example.testnet","principal":"account:player-example.testnet"}"#).unwrap();
        let hash: String = env::sha256_array(canonical_json(&value).as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            hash,
            "444d932b731adea4360c2381f932c1fecc5c6475ac87ddaa1f3200c389a7cd3f"
        );
        assert!(valid_hash("11111111111111111111111111111111"));
        assert!(!valid_hash("111111111111111111111111111111111"));
    }
}
