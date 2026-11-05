use super::*;
use near_sdk::serde::Serialize;

#[derive(Serialize, Deserialize, near_sdk::NearSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", try_from = "String", into = "String")]
pub struct Decimal(#[schemars(with = "String")] pub u64);
impl TryFrom<String> for Decimal {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty()
            || value.len() > 20
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err("LT:E_INVALID_INTEGER");
        }
        value.parse().map(Self).map_err(|_| "LT:E_INVALID_INTEGER")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{NearToken, test_utils::VMContextBuilder, testing_env};
    fn context(actor: &str, payload: Value, time: u64) {
        let mut ctx = VMContextBuilder::new()
            .current_account_id("town.testnet".parse().unwrap())
            .predecessor_account_id(actor.parse().unwrap())
            .signer_account_id(actor.parse().unwrap())
            .account_balance(NearToken::from_near(1000))
            .block_timestamp(time)
            .build();
        ctx.input = serde_json::to_vec(&payload).unwrap().into();
        testing_env!(ctx);
    }
    fn initialize() -> LivingTown {
        context("town.testnet", json!({}), 1);
        let digest = config_digest();
        let payload = json!({"owner_account_id":"owner.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"operator_account_id":"operator.testnet","network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest});
        context("town.testnet", payload, 1);
        LivingTown::initialize_town(
            "owner.testnet".parse().unwrap(),
            Controllers {
                rex: "rex.testnet".parse().unwrap(),
                luna: "luna.testnet".parse().unwrap(),
                bolt: "bolt.testnet".parse().unwrap(),
            },
            "operator.testnet".parse().unwrap(),
            "11111111111111111111111111111111".to_owned(),
            digest,
        )
    }
    #[test]
    fn decimal_and_name_boundaries_are_exact() {
        for value in [
            "",
            "00",
            "01",
            "-1",
            "+1",
            " 1",
            "1e2",
            "18446744073709551616",
        ] {
            assert!(Decimal::try_from(value.to_owned()).is_err());
        }
        assert_eq!(
            Decimal::try_from("18446744073709551615".to_owned())
                .unwrap()
                .0,
            u64::MAX
        );
        assert!(name_ok("A"));
        assert!(name_ok(&"x".repeat(32)));
        assert!(!name_ok(&"x".repeat(33)));
        assert!(!name_ok("é"));
        assert!(!name_ok(""));
    }
    #[test]
    fn registration_capacity_and_pause_reject_before_grant_or_command_allocation() {
        let mut town = initialize();
        let command = Command {
            sequence: Decimal(1),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        };
        for paused in [false, true] {
            town.paused = paused;
            town.registered_player_count = if paused { 0 } else { 1000 };
            context("player.testnet", json!({"command":command}), 2);
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                    || town.register_player(command.clone())
                ))
                .is_err()
            );
            assert_eq!(town.issued_grants, 0);
            assert_eq!(town.market_revision, 1);
            assert!(
                !town
                    .players
                    .contains_key(&"player.testnet".parse::<AccountId>().unwrap())
            );
            assert!(
                !town
                    .commands
                    .contains_key(&"player.testnet".parse::<AccountId>().unwrap())
            );
        }
    }
    #[test]
    fn stored_commands_survive_borsh_reopen_and_expired_replay_without_another_grant() {
        let mut town = initialize();
        let command = Command {
            sequence: Decimal(1),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        };
        context("player.testnet", json!({"command":command}), 2);
        let first = town.register_player(command.clone());
        assert_eq!(first["data"]["replayed"], false);
        let bytes = near_sdk::borsh::to_vec(&town).unwrap();
        drop(town);
        context(
            "player.testnet",
            json!({"command":command}),
            1_000_000_000_000,
        );
        let mut reopened: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
        let replay = reopened.register_player(command);
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(reopened.issued_grants, 100);
        assert_eq!(reopened.registered_player_count, 1);
        assert_eq!(reopened.market_revision, 2);
    }
}
impl From<Decimal> for String {
    fn from(value: Decimal) -> Self {
        value.0.to_string()
    }
}
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub sequence: Decimal,
    pub config_version: Decimal,
    pub valid_until_ns: Decimal,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Player {
    pub account_id: AccountId,
    pub gold: u64,
    pub inventory: Inventory,
    pub ledger_revision: u64,
    pub shop_id: Option<u64>,
    pub grant_sequence: u64,
    pub reservations: super::purchases::Reservations,
}
impl Player {
    pub(super) fn ledger(&self) -> Value {
        super::purchases::ledger(
            json!({"kind":"player","account_id":self.account_id}),
            self.gold,
            self.inventory,
            self.ledger_revision,
            &self.reservations,
        )
    }
    fn view(&self) -> Value {
        json!({"account_id":self.account_id,"ledger":self.ledger(),"shop_id":self.shop_id.map(|id|id.to_string()),"grant_issued":true,"grant_command_sequence":self.grant_sequence.to_string()})
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Shop {
    pub id: u64,
    pub owner: AccountId,
    pub name: String,
    pub revision: u64,
    pub created_at_ns: u64,
    pub creation_sequence: u64,
}
impl Shop {
    fn view(&self) -> Value {
        json!({"shop_id":self.id.to_string(),"owner":{"kind":"player","account_id":self.owner},"name":self.name,"revision":self.revision.to_string(),"production_slots":"1","policy_revision":"1","created_at_ns":self.created_at_ns.to_string(),"ownership_command_sequence":self.creation_sequence.to_string()})
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) enum Outcome {
    Registered(Box<Player>),
    Created(Shop),
    Renamed(Shop),
    Purchased(Box<super::purchases::Purchase>),
}
impl Outcome {
    fn method(&self) -> &'static str {
        match self {
            Self::Registered(_) => "register_player",
            Self::Created(_) => "create_shop",
            Self::Renamed(_) => "rename_shop",
            Self::Purchased(_) => "buy_from_merchant",
        }
    }
    fn view(&self) -> Value {
        match self {
            Self::Registered(p) => json!({"kind":"player_registered","player":p.view()}),
            Self::Created(s) => json!({"kind":"shop_created","shop":s.view()}),
            Self::Renamed(s) => json!({"kind":"shop_renamed","shop":s.view()}),
            Self::Purchased(p) => p.view(),
        }
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct CommandRecord {
    pub sequence: u64,
    pub digest: [u8; 32],
    pub revision: u64,
    pub outcome: Outcome,
}
pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(super) fn next(value: u64) -> u64 {
    value
        .checked_add(1)
        .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"))
}
fn name_ok(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'_' | b'-'))
}
pub(super) fn args<T: DeserializeOwned>(keys: &[&str]) -> T {
    let raw = env::input().unwrap_or_default();
    require!(raw.len() <= 8192, "LT:E_INVALID_ARGUMENT");
    let shape: Value =
        serde_json::from_slice(&raw).unwrap_or_else(|_| env::panic_str("LT:E_INVALID_ARGUMENT"));
    require!(
        shape
            .as_object()
            .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))),
        "LT:E_INVALID_ARGUMENT"
    );
    input()
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct RegisterArgs {
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct CreateArgs {
    name: String,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct RenameArgs {
    shop_id: Decimal,
    expected_shop_revision: Decimal,
    name: String,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PlayerArgs {
    account_id: AccountId,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ShopArgs {
    shop_id: Decimal,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PageArgs {
    account_id: AccountId,
    after_id: Option<Decimal>,
    limit: Decimal,
    expected_market_revision: Decimal,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct LookupArgs {
    principal: String,
    sequence: Decimal,
}

impl LivingTown {
    pub(super) fn player_principal(&self) -> AccountId {
        let id = env::predecessor_account_id();
        require!(
            id != env::current_account_id()
                && id != self.owner
                && id != self.operator
                && !self.controllers.contains(&id),
            "LT:E_RESERVED_ACCOUNT"
        );
        id
    }
    fn effect(&self, actor: &AccountId, record: &CommandRecord, replayed: bool) -> Value {
        json!({"principal":format!("account:{actor}"),"command_sequence":record.sequence.to_string(),"payload_sha256":hex(&record.digest),"replayed":replayed,"effect_revision":record.revision.to_string(),"effect_event_sequence":record.revision.to_string(),"outcome":record.outcome.view()})
    }
    pub(super) fn command_check(
        &self,
        actor: &AccountId,
        method: &str,
        normalized: Value,
        command: &Command,
    ) -> ([u8; 32], Option<Value>) {
        self.assert_versions();
        require!(command.sequence.0 > 0, "LT:E_INVALID_INTEGER");
        let payload = json!({"domain":"bot-bazaar:living-town:command:1","network_id":"testnet","genesis_hash":self.genesis_hash,"contract_id":env::current_account_id(),"api_version":"2.0.0","principal":format!("account:{actor}"),"predecessor_account_id":actor,"method":method,"args":normalized});
        let digest = env::sha256_array(canonical_json(&payload).as_bytes());
        let high = self.commands.get(actor).map_or(0, |r| r.sequence);
        if command.sequence.0 <= high {
            require!(command.sequence.0 == high, "LT:E_COMMAND_PRUNED");
            let record = self.commands.get(actor).expect("high-water exists");
            require!(
                record.digest == digest && record.outcome.method() == method,
                "LT:E_COMMAND_CONFLICT"
            );
            return (
                digest,
                Some(self.snapshot(self.effect(actor, record, true))),
            );
        }
        let expected = high
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("LT:E_SEQUENCE_EXHAUSTED"));
        require!(command.sequence.0 == expected, "LT:E_COMMAND_GAP");
        require!(
            command.config_version.0 == self.config_version,
            "LT:E_CONFIG_CHANGED"
        );
        let now = env::block_timestamp();
        require!(
            command.valid_until_ns.0 > now
                && command.valid_until_ns.0
                    <= now
                        .checked_add(600_000_000_000)
                        .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW")),
            "LT:E_COMMAND_EXPIRED"
        );
        require!(!self.paused, "LT:E_MARKET_PAUSED");
        (digest, None)
    }
    pub(super) fn commit(
        &mut self,
        actor: AccountId,
        command: Command,
        digest: [u8; 32],
        outcome: Outcome,
    ) -> Value {
        self.market_revision = next(self.market_revision);
        let record = CommandRecord {
            sequence: command.sequence.0,
            digest,
            revision: self.market_revision,
            outcome,
        };
        require!(
            near_sdk::borsh::to_vec(&record).expect("record").len() <= 4096,
            "LT:E_STORAGE_CAPACITY"
        );
        self.commands.insert(actor.clone(), record.clone());
        // Force all buffered collection writes and the root into this receipt before
        // checking measured storage/funding. A failed requirement reverts the receipt.
        self.players.flush();
        self.shops.flush();
        self.commands.flush();
        self.trades.flush();
        env::state_write(self);
        let used = env::storage_usage();
        require!(used <= 16 * 1024 * 1024, "LT:E_STORAGE_CAPACITY");
        let stake = u128::from(used)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        let required = stake
            .checked_add(stake.div_ceil(4))
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        require!(
            env::account_balance().as_yoctonear() >= required,
            "LT:E_STORAGE_CAPACITY"
        );
        let event = json!({"standard":"bot_bazaar_living_town","version":"2.0.0","event":record.outcome.method(),"data":[{"contract_id":env::current_account_id(),"config_version":self.config_version.to_string(),"event_sequence":self.market_revision.to_string(),"market_revision":self.market_revision.to_string(),"block_height":env::block_height().to_string(),"block_timestamp_ns":env::block_timestamp().to_string(),"predecessor_account_id":actor,"principal":format!("account:{actor}"),"command_sequence":record.sequence.to_string(),"payload_sha256":hex(&digest),"outcome":record.outcome.view()}]});
        let encoded = serde_json::to_string(&event).expect("event");
        require!(encoded.len() <= 32768, "LT:E_STORAGE_CAPACITY");
        env::log_str(&format!("EVENT_JSON:{encoded}"));
        self.snapshot(self.effect(&actor, &record, false))
    }
}
#[near]
impl LivingTown {
    pub fn register_player(&mut self, command: Command) -> Value {
        let parsed: RegisterArgs = args(&["command"]);
        require!(parsed.command == command, "LT:E_INVALID_ARGUMENT");
        let actor = self.player_principal();
        let (digest, replay) = self.command_check(
            &actor,
            "register_player",
            json!({"command":command}),
            &command,
        );
        if let Some(value) = replay {
            return value;
        }
        require!(
            !self.players.contains_key(&actor),
            "LT:E_ALREADY_REGISTERED"
        );
        require!(self.registered_player_count < 1000, "LT:E_PLAYER_CAPACITY");
        let player = Player {
            account_id: actor.clone(),
            gold: 100,
            inventory: Inventory::default(),
            ledger_revision: 1,
            shop_id: None,
            grant_sequence: command.sequence.0,
            reservations: super::purchases::Reservations::default(),
        };
        self.registered_player_count = next(self.registered_player_count);
        self.issued_grants = self
            .issued_grants
            .checked_add(100)
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        self.players.insert(actor.clone(), player.clone());
        self.commit(
            actor,
            command,
            digest,
            Outcome::Registered(Box::new(player)),
        )
    }
    pub fn create_shop(&mut self, name: String, command: Command) -> Value {
        let parsed: CreateArgs = args(&["name", "command"]);
        require!(
            parsed.name == name && parsed.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = self.player_principal();
        require!(self.players.contains_key(&actor), "LT:E_NOT_REGISTERED");
        let (digest, replay) = self.command_check(
            &actor,
            "create_shop",
            json!({"name":name,"command":command}),
            &command,
        );
        if let Some(value) = replay {
            return value;
        }
        require!(name_ok(&name), "LT:E_INVALID_ARGUMENT");
        require!(
            self.players.get(&actor).expect("player").shop_id.is_none(),
            "LT:E_SHOP_EXISTS"
        );
        let id = self.next_shop_id;
        self.next_shop_id = next(id);
        let shop = Shop {
            id,
            owner: actor.clone(),
            name,
            revision: 1,
            created_at_ns: env::block_timestamp(),
            creation_sequence: command.sequence.0,
        };
        self.players.get_mut(&actor).expect("player").shop_id = Some(id);
        self.shops.insert(id, shop.clone());
        self.commit(actor, command, digest, Outcome::Created(shop))
    }
    pub fn rename_shop(
        &mut self,
        shop_id: Decimal,
        expected_shop_revision: Decimal,
        name: String,
        command: Command,
    ) -> Value {
        let parsed: RenameArgs = args(&["shop_id", "expected_shop_revision", "name", "command"]);
        require!(
            parsed.shop_id == shop_id
                && parsed.expected_shop_revision == expected_shop_revision
                && parsed.name == name
                && parsed.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = self.player_principal();
        let shop = self
            .shops
            .get(&shop_id.0)
            .unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"));
        require!(shop.owner == actor, "LT:E_NOT_OWNER");
        let (digest,replay)=self.command_check(&actor,"rename_shop",json!({"shop_id":shop_id,"expected_shop_revision":expected_shop_revision,"name":name,"command":command}),&command);
        if let Some(value) = replay {
            return value;
        }
        require!(name_ok(&name), "LT:E_INVALID_ARGUMENT");
        require!(shop.revision == expected_shop_revision.0, "LT:E_STALE_SHOP");
        require!(shop.name != name, "LT:E_NO_CHANGE");
        let mut shop = shop.clone();
        shop.name = name;
        shop.revision = next(shop.revision);
        self.shops.insert(shop.id, shop.clone());
        self.commit(actor, command, digest, Outcome::Renamed(shop))
    }
    pub fn get_player(&self, account_id: AccountId) -> Value {
        let parsed: PlayerArgs = args(&["account_id"]);
        require!(parsed.account_id == account_id, "LT:E_INVALID_ARGUMENT");
        self.assert_versions();
        self.snapshot(
            self.players
                .get(&account_id)
                .map(Player::view)
                .unwrap_or(Value::Null),
        )
    }
    pub fn get_shop(&self, shop_id: Decimal) -> Value {
        let parsed: ShopArgs = args(&["shop_id"]);
        require!(
            parsed.shop_id == shop_id && shop_id.0 > 0,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        let value = if shop_id.0 <= 3 {
            self.town()["npc_shops"][shop_id.0 as usize - 1].clone()
        } else {
            self.shops
                .get(&shop_id.0)
                .map(Shop::view)
                .unwrap_or(Value::Null)
        };
        self.snapshot(value)
    }
    pub fn get_player_shops(
        &self,
        account_id: AccountId,
        after_id: Option<Decimal>,
        limit: Decimal,
        expected_market_revision: Decimal,
    ) -> Value {
        let parsed: PageArgs = args(&[
            "account_id",
            "after_id",
            "limit",
            "expected_market_revision",
        ]);
        require!(
            parsed.account_id == account_id
                && parsed.after_id == after_id
                && parsed.limit == limit
                && parsed.expected_market_revision == expected_market_revision,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        require!((1..=50).contains(&limit.0), "LT:E_INVALID_PAGE");
        require!(
            expected_market_revision.0 == self.market_revision,
            "LT:E_STALE_SNAPSHOT"
        );
        let mut items = Vec::new();
        let mut cursor = after_id.map(|id| id.0);
        if let Some(id) = self.players.get(&account_id).and_then(|p| p.shop_id)
            && after_id.is_none_or(|after| id > after.0)
        {
            items.push(self.shops.get(&id).expect("owner shop index").view());
            cursor = Some(id);
        }
        self.snapshot(json!({"items":items,"next_after_id":cursor.map(|id|id.to_string()),"has_more":false,"history_gap":false,"pruned_through":"0"}))
    }
    pub fn get_command(&self, principal: String, sequence: Decimal) -> Value {
        let parsed: LookupArgs = args(&["principal", "sequence"]);
        require!(
            parsed.principal == principal && parsed.sequence == sequence && sequence.0 > 0,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        let actor: AccountId = principal
            .strip_prefix("account:")
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"));
        let record = self.commands.get(&actor);
        let high = record.map_or(0, |r| r.sequence);
        let value = if let Some(r) = record
            && sequence.0 == high
        {
            json!({"kind":"found","high_water":high.to_string(),"method":r.outcome.method(),"payload_sha256":hex(&r.digest),"effect":self.effect(&actor,r,false)})
        } else if sequence.0 <= high {
            json!({"kind":"pruned","high_water":high.to_string(),"sequence":sequence.0.to_string()})
        } else {
            json!({"kind":"not_applied","high_water":high.to_string(),"next_sequence":high.checked_add(1).unwrap_or_else(||env::panic_str("LT:E_SEQUENCE_EXHAUSTED")).to_string()})
        };
        self.snapshot(value)
    }
}
