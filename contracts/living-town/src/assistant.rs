use super::*;
use ownership::{Outcome, args, next};

/// Public permission settings only. No private recommendations or spending authority.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Off,
    Recommendations,
    AutoReprice,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production::tests::{context, town};

    fn enabled() -> PolicyInput {
        PolicyInput {
            mode: Mode::AutoReprice,
            operator_account_id: Some("operator.testnet".parse().unwrap()),
            allowed_items: vec!["iron_tool".into(), "health_potion".into()],
            min_price: Decimal(5),
            max_price: Decimal(25),
            expires_at_ns: Some(Decimal(400_000_000_000)),
        }
    }
    fn set(
        t: &mut LivingTown,
        actor: &str,
        seq: u64,
        revision: u64,
        policy: PolicyInput,
        now: u64,
    ) -> Value {
        let command = Command {
            sequence: Decimal(seq),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        };
        context(
            actor,
            json!({"shop_id":"4","expected_policy_revision":revision.to_string(),"policy":policy,"command":command}),
            now,
        );
        t.set_assistant_permissions(Decimal(4), Decimal(revision), policy, command)
    }
    #[test]
    fn policy_revisions_revocation_and_replays_preserve_economic_state() {
        let mut t = town();
        let ledger = t
            .players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap()
            .ledger();
        assert!(t.shops.get(&4).unwrap().assistant.is_off());
        let first = set(&mut t, "player.testnet", 3, 1, enabled(), 4);
        assert_eq!(first["data"]["outcome"]["policy"]["revision"], "2");
        assert_eq!(first["data"]["outcome"]["shop"]["revision"], "2");
        t.paused = true;
        let replay = set(&mut t, "player.testnet", 3, 1, enabled(), 450_000_000_000);
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(first["data"]["outcome"], replay["data"]["outcome"]);
        set(
            &mut t,
            "player.testnet",
            4,
            2,
            PolicyInput::default(),
            450_000_000_000,
        );
        let revision = t.market_revision;
        let bytes = near_sdk::borsh::to_vec(&t).unwrap();
        drop(t);
        let mut reopened: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
        let replay = set(
            &mut reopened,
            "player.testnet",
            4,
            2,
            PolicyInput::default(),
            600_000_000_000,
        );
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(reopened.market_revision, revision);
        assert!(reopened.shops.get(&4).unwrap().assistant.is_off());
        assert_eq!(
            ledger,
            reopened
                .players
                .get(&"player.testnet".parse::<AccountId>().unwrap())
                .unwrap()
                .ledger()
        );
    }
    #[test]
    fn authorization_and_policy_boundaries_reject_without_consuming_command() {
        let mut t = town();
        let revision = t.market_revision;
        let mut invalid = vec![];
        let mut p = enabled();
        p.operator_account_id = Some("attacker.testnet".parse().unwrap());
        invalid.push(p);
        let mut p = enabled();
        p.expires_at_ns = None;
        invalid.push(p);
        let mut p = enabled();
        p.expires_at_ns = Some(Decimal(4));
        invalid.push(p);
        let mut p = enabled();
        p.allowed_items = vec!["herb".into()];
        invalid.push(p);
        let mut p = enabled();
        p.allowed_items = vec!["iron_tool".into(); 2];
        invalid.push(p);
        let mut p = enabled();
        p.allowed_items.clear();
        invalid.push(p);
        let mut p = enabled();
        p.min_price = Decimal(0);
        invalid.push(p);
        let mut p = enabled();
        p.max_price = Decimal(101);
        invalid.push(p);
        let mut p = enabled();
        p.min_price = Decimal(26);
        invalid.push(p);
        let mut p = enabled();
        p.mode = Mode::Recommendations;
        invalid.push(p);
        let mut p = enabled();
        p.mode = Mode::Off;
        invalid.push(p);
        invalid.push(PolicyInput::default()); // unchanged initial off policy
        for policy in invalid {
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                    &mut t,
                    "player.testnet",
                    3,
                    1,
                    policy,
                    4
                )))
                .is_err()
            );
            assert_eq!(t.market_revision, revision);
            assert_eq!(t.shops.get(&4).unwrap().assistant.revision, 1);
        }
        for actor in [
            "attacker.testnet",
            "operator.testnet",
            "owner.testnet",
            "rex.testnet",
            "town.testnet",
        ] {
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                    &mut t,
                    actor,
                    1,
                    1,
                    enabled(),
                    4
                )))
                .is_err()
            );
        }
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                &mut t,
                "player.testnet",
                3,
                2,
                enabled(),
                4
            )))
            .is_err()
        );
        t.paused = true;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                &mut t,
                "player.testnet",
                3,
                1,
                enabled(),
                4
            )))
            .is_err()
        );
        t.paused = false;
        set(&mut t, "player.testnet", 3, 1, enabled(), 4);
        let mut reordered = enabled();
        reordered.allowed_items.reverse();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                &mut t,
                "player.testnet",
                4,
                2,
                reordered,
                4
            )))
            .is_err()
        );
        for extra in ["quantity", "recipient", "allowed_actions", "spend_limit"] {
            let mut raw = serde_json::to_value(enabled()).unwrap();
            raw[extra] = json!("1");
            assert!(serde_json::from_value::<PolicyInput>(raw).is_err());
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicyInput {
    pub mode: Mode,
    pub operator_account_id: Option<AccountId>,
    pub allowed_items: Vec<String>,
    pub min_price: Decimal,
    pub max_price: Decimal,
    pub expires_at_ns: Option<Decimal>,
}
impl Default for PolicyInput {
    fn default() -> Self {
        Self {
            mode: Mode::Off,
            operator_account_id: None,
            allowed_items: vec![],
            min_price: Decimal(1),
            max_price: Decimal(1),
            expires_at_ns: None,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Policy {
    pub revision: u64,
    mode: Mode,
    operator_account_id: Option<AccountId>,
    allowed_items: Vec<String>,
    min_price: u64,
    max_price: u64,
    expires_at_ns: Option<u64>,
}
impl Default for Policy {
    fn default() -> Self {
        Self::new(1, PolicyInput::default())
    }
}
impl Policy {
    fn new(revision: u64, p: PolicyInput) -> Self {
        Self {
            revision,
            mode: p.mode,
            operator_account_id: p.operator_account_id,
            allowed_items: p.allowed_items,
            min_price: p.min_price.0,
            max_price: p.max_price.0,
            expires_at_ns: p.expires_at_ns.map(|v| v.0),
        }
    }
    fn input(&self) -> PolicyInput {
        PolicyInput {
            mode: self.mode.clone(),
            operator_account_id: self.operator_account_id.clone(),
            allowed_items: self.allowed_items.clone(),
            min_price: Decimal(self.min_price),
            max_price: Decimal(self.max_price),
            expires_at_ns: self.expires_at_ns.map(Decimal),
        }
    }
    pub(super) fn is_off(&self) -> bool {
        self.mode == Mode::Off
    }
    pub(super) fn view(&self, shop_id: u64) -> Value {
        let mut value = serde_json::to_value(self.input()).expect("policy");
        value["shop_id"] = json!(shop_id.to_string());
        value["revision"] = json!(self.revision.to_string());
        value
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct SetArgs {
    shop_id: Decimal,
    expected_policy_revision: Decimal,
    policy: PolicyInput,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct GetArgs {
    shop_id: Decimal,
}

#[near]
impl LivingTown {
    pub fn get_assistant_policy(&self, shop_id: Decimal) -> Value {
        let p: GetArgs = args(&["shop_id"]);
        require!(p.shop_id == shop_id, "LT:E_INVALID_ARGUMENT");
        self.assert_versions();
        let shop = self.shops.get(&shop_id.0).expect("LT:E_SHOP_NOT_FOUND");
        self.snapshot(shop.assistant.view(shop.id))
    }

    pub fn set_assistant_permissions(
        &mut self,
        shop_id: Decimal,
        expected_policy_revision: Decimal,
        policy: PolicyInput,
        command: Command,
    ) -> Value {
        let p: SetArgs = args(&["shop_id", "expected_policy_revision", "policy", "command"]);
        let raw: Value = input();
        require!(
            raw["policy"].as_object().is_some_and(|p| p.len() == 6
                && [
                    "mode",
                    "operator_account_id",
                    "allowed_items",
                    "min_price",
                    "max_price",
                    "expires_at_ns"
                ]
                .iter()
                .all(|k| p.contains_key(*k))),
            "LT:E_INVALID_ARGUMENT"
        );
        require!(
            p.shop_id == shop_id
                && p.expected_policy_revision == expected_policy_revision
                && p.policy == policy
                && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = self.player_principal();
        let mut shop = self
            .shops
            .get(&shop_id.0)
            .expect("LT:E_SHOP_NOT_FOUND")
            .clone();
        require!(shop.owner == actor, "LT:E_UNAUTHORIZED");
        // Replay before time/revision checks: return the original effect, never re-enable.
        let (digest, replay) = self.command_check(&actor, "set_assistant_permissions",
            json!({"shop_id":shop_id,"expected_policy_revision":expected_policy_revision,"policy":policy,"command":command}), &command);
        if let Some(result) = replay {
            return result;
        }
        require!(
            shop.assistant.revision == expected_policy_revision.0,
            "LT:E_POLICY_CHANGED"
        );
        require!(
            policy.allowed_items.len() <= 2
                && policy
                    .allowed_items
                    .iter()
                    .all(|i| i == "health_potion" || i == "iron_tool"),
            "LT:E_POLICY_ITEMS"
        );
        let mut settings = policy;
        settings.allowed_items.sort();
        require!(
            settings.allowed_items.windows(2).all(|p| p[0] != p[1]),
            "LT:E_POLICY_ITEMS"
        );
        require!(
            settings.min_price.0 >= 1
                && settings.max_price.0 <= 100
                && settings.min_price.0 <= settings.max_price.0,
            "LT:E_POLICY_PRICE"
        );
        if settings.mode == Mode::Off {
            require!(settings == PolicyInput::default(), "LT:E_POLICY_OFF");
        } else {
            require!(!settings.allowed_items.is_empty(), "LT:E_POLICY_ITEMS");
            require!(
                settings
                    .expires_at_ns
                    .is_none_or(|v| v.0 > env::block_timestamp()),
                "LT:E_POLICY_EXPIRED"
            );
            if settings.mode == Mode::AutoReprice {
                require!(
                    settings.operator_account_id.as_ref() == Some(&self.operator),
                    "LT:E_POLICY_OPERATOR"
                );
                require!(settings.expires_at_ns.is_some(), "LT:E_POLICY_EXPIRED");
            } else {
                require!(
                    settings.operator_account_id.is_none(),
                    "LT:E_POLICY_OPERATOR"
                );
            }
        }
        require!(settings != shop.assistant.input(), "LT:E_NO_CHANGE");
        shop.assistant = Policy::new(next(shop.assistant.revision), settings);
        shop.revision = next(shop.revision);
        self.shops.insert(shop.id, shop.clone());
        self.commit(actor, command, digest, Outcome::AssistantPolicy(shop))
    }
}
