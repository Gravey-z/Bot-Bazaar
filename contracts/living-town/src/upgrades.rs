use super::*;
use ownership::{Outcome, args, next};

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Purchased {
    shop: Shop,
    player: Player,
    cost: u64,
}
impl Purchased {
    pub(super) fn view(&self) -> Value {
        json!({"kind":"upgrade_purchased","upgrade_id":"second_slot","shop":self.shop.view(),"ledger":self.player.ledger(),"gold_burned":self.cost.to_string()})
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PurchaseArgs {
    shop_id: Decimal,
    upgrade_id: String,
    expected_shop_revision: Decimal,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ReadArgs {
    shop_id: Decimal,
}
fn terms() -> (u64, u64) {
    let economy = &config()["economy"];
    (
        economy["upgradeCost"].as_str().unwrap().parse().unwrap(),
        economy["upgradeReserve"].as_str().unwrap().parse().unwrap(),
    )
}
#[near]
impl LivingTown {
    pub fn get_upgrade(&self, shop_id: Decimal) -> Value {
        let p: ReadArgs = args(&["shop_id"]);
        require!(p.shop_id == shop_id, "LT:E_INVALID_ARGUMENT");
        self.assert_versions();
        let shop = self
            .shops
            .get(&shop_id.0)
            .unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"));
        let player = self.players.get(&shop.owner).expect("owner");
        let (cost, reserve) = terms();
        let eligible = !self.paused
            && shop.production_slots == 1
            && shop.completed_products == 3
            && shop.sold_products == 3
            && player
                .gold
                .checked_sub(player.reservations.gold_trade)
                .is_some_and(|g| g >= cost + reserve);
        self.snapshot(json!({"shop_id":shop_id,"upgrade_id":"second_slot","shop_revision":shop.revision.to_string(),"production_slots":shop.production_slots.to_string(),"completed_both":shop.completed_products==3,"sold_both":shop.sold_products==3,"gold_cost":cost.to_string(),"minimum_reserve":reserve.to_string(),"eligible":eligible}))
    }
    pub fn purchase_upgrade(
        &mut self,
        shop_id: Decimal,
        upgrade_id: String,
        expected_shop_revision: Decimal,
        command: Command,
    ) -> Value {
        let p: PurchaseArgs = args(&["shop_id", "upgrade_id", "expected_shop_revision", "command"]);
        require!(
            p.shop_id == shop_id
                && p.upgrade_id == upgrade_id
                && p.expected_shop_revision == expected_shop_revision
                && p.command == command
                && upgrade_id == "second_slot",
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = env::predecessor_account_id();
        let mut shop = self
            .shops
            .get(&shop_id.0)
            .unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"))
            .clone();
        require!(shop.owner == actor, "LT:E_NOT_OWNER");
        let (digest,replay) = self.command_check(&actor,"purchase_upgrade",json!({"shop_id":shop_id,"upgrade_id":upgrade_id,"expected_shop_revision":expected_shop_revision,"command":command}),&command);
        if let Some(result) = replay {
            return result;
        }
        require!(shop.revision == expected_shop_revision.0, "LT:E_STALE_SHOP");
        require!(shop.production_slots == 1, "LT:E_UPGRADE_PURCHASED");
        require!(
            shop.completed_products == 3 && shop.sold_products == 3,
            "LT:E_UPGRADE_PREREQUISITES"
        );
        let mut player = self.players.get(&actor).expect("owner").clone();
        let (cost, reserve) = terms();
        require!(
            player
                .gold
                .checked_sub(player.reservations.gold_trade)
                .is_some_and(|g| g >= cost + reserve),
            "LT:E_INSUFFICIENT_AVAILABLE_GOLD"
        );
        let burned = self
            .upgrade_burns
            .checked_add(u128::from(cost))
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        player.ledger_revision = next(player.ledger_revision);
        shop.revision = next(shop.revision);
        next(self.market_revision);
        player.gold -= cost;
        shop.production_slots = 2;
        self.upgrade_burns = burned;
        self.players.insert(actor.clone(), player.clone());
        self.shops.insert(shop.id, shop.clone());
        self.commit(
            actor,
            command,
            digest,
            Outcome::Upgrade(Box::new(Purchased { shop, player, cost })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production::tests::{context, town};
    fn buy(t: &mut LivingTown, seq: u64, revision: u64) -> Value {
        let c = Command {
            sequence: Decimal(seq),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        };
        context(
            "player.testnet",
            json!({"shop_id":"4","upgrade_id":"second_slot","expected_shop_revision":revision.to_string(),"command":c}),
            100,
        );
        t.purchase_upgrade(Decimal(4), "second_slot".into(), Decimal(revision), c)
    }
    fn eligible(t: &mut LivingTown) {
        let shop = t.shops.get_mut(&4).unwrap();
        shop.completed_products = 3;
        shop.sold_products = 3;
        t.players
            .get_mut(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap()
            .gold = 180;
    }
    #[test]
    fn one_time_sink_replay_and_reopen() {
        let mut t = town();
        eligible(&mut t);
        let first = buy(&mut t, 3, 1);
        assert_eq!(first["data"]["outcome"]["shop"]["production_slots"], "2");
        assert_eq!(
            first["data"]["outcome"]["ledger"]["gold"]["available"],
            "30"
        );
        assert_eq!(t.upgrade_burns, 150);
        let replay = buy(&mut t, 3, 1);
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(t.upgrade_burns, 150);
        t.persist_economic_state(false);
        let bytes = near_sdk::borsh::to_vec(&t).unwrap();
        drop(t);
        let mut t: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(&mut t, 4, 2))).is_err()
        );
        assert_eq!(t.upgrade_burns, 150);
    }
    #[test]
    fn invalid_prerequisites_reservations_and_overflow_do_not_mutate() {
        for kind in 0..7 {
            near_sdk::mock::with_mocked_blockchain(|b| {
                b.take_storage();
            });
            let mut t = town();
            eligible(&mut t);
            match kind {
                0 => t.shops.get_mut(&4).unwrap().completed_products = 1,
                1 => t.shops.get_mut(&4).unwrap().sold_products = 1,
                2 => {
                    t.players
                        .get_mut(&"player.testnet".parse::<AccountId>().unwrap())
                        .unwrap()
                        .gold = 179
                }
                3 => {
                    t.players
                        .get_mut(&"player.testnet".parse::<AccountId>().unwrap())
                        .unwrap()
                        .reservations
                        .gold_trade = 1
                }
                4 => t.paused = true,
                5 => t.upgrade_burns = u128::MAX,
                _ => t.shops.get_mut(&4).unwrap().revision = 2,
            }
            let before = t.town();
            let shop = t.shops.get(&4).unwrap().view();
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(&mut t, 3, 1)))
                    .is_err()
            );
            assert_eq!(t.town(), before);
            assert_eq!(t.shops.get(&4).unwrap().view(), shop);
        }
    }
    #[test]
    fn concurrent_slots_preserve_jobs_and_release_only_the_completed_slot() {
        let mut t = town();
        eligible(&mut t);
        let original = crate::production::tests::start(&mut t, 3, 1);
        buy(&mut t, 4, 2);
        let c = Command {
            sequence: Decimal(5),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        };
        context(
            "player.testnet",
            json!({"shop_id":"4","recipe_id":"iron_tool","recipe_version":"1","quantity":"1","expected_shop_revision":"3","command":c}),
            101,
        );
        t.start_production(
            Decimal(4),
            RecipeId::IronTool,
            Decimal(1),
            Decimal(1),
            Decimal(3),
            c,
        );
        assert_eq!(
            t.jobs.get(&1).unwrap().view(),
            original["data"]["outcome"]["job"]
        );
        assert_eq!(t.active_jobs.get(&4), Some(&1));
        assert_eq!(t.second_active_jobs.get(&4), Some(&2));
        context("other.testnet", json!({"job_id":"2"}), 200_000_000_000);
        t.complete_production(Decimal(2));
        assert_eq!(t.active_jobs.get(&4), Some(&1));
        assert!(t.second_active_jobs.get(&4).is_none());
        context("other.testnet", json!({"job_id":"1"}), 200_000_000_001);
        t.complete_production(Decimal(1));
        assert!(t.active_jobs.get(&4).is_none());
    }
}
