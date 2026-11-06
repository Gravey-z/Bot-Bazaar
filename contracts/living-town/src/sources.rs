use super::*;
use ownership::{Outcome, args, next};

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Allocation {
    pub item: Option<Item>,
    merchant: MerchantId,
    epoch: u64,
    amount: u64,
    npc: Npc,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production::tests::{context, town};
    fn cmd(e: u64, s: u64) -> Command {
        Command {
            sequence: Decimal(s),
            config_version: Decimal(1),
            valid_until_ns: Decimal(e * 60_000_000_000 + 500_000_000_001),
        }
    }
    fn raw(t: &mut LivingTown, item: Item, e: u64, s: u64) -> Value {
        let c = cmd(e, s);
        context(
            "operator.testnet",
            json!({"item_id":item,"epoch":e.to_string(),"command":c}),
            e * 60_000_000_000 + 1,
        );
        t.allocate_raw_supply(item, Decimal(e), c)
    }
    #[test]
    fn source_epochs_zero_replay_pruning_and_long_downtime_are_persistent() {
        let mut t = town();
        let first = raw(&mut t, Item::Crystal, 1, 1);
        assert_eq!(first["data"]["outcome"]["issued_quantity"], "0");
        assert_eq!(raw(&mut t, Item::Crystal, 1, 1)["data"]["replayed"], true);
        let before = t.raw_epochs;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| raw(
                &mut t,
                Item::Crystal,
                1,
                2
            )))
            .is_err()
        );
        assert_eq!(t.raw_epochs, before);
        raw(&mut t, Item::Herb, 1, 2);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| raw(
                &mut t,
                Item::Crystal,
                1,
                1
            )))
            .is_err()
        );
        t.npcs[0].held.quantities[0] = 0;
        t.npcs[0].listings[0].as_mut().unwrap().quantity = 0;
        raw(&mut t, Item::Crystal, 10000, 3);
        assert_eq!(t.npcs[0].held.quantities[0], 4);
        assert_eq!(t.supplied_items[0], 4);
        raw(&mut t, Item::Crystal, 10001, 4);
        assert_eq!(t.npcs[0].held.quantities[0], 8);
        raw(&mut t, Item::Crystal, 10002, 5);
        assert_eq!(t.npcs[0].held.quantities[0], 10);
        assert_eq!(t.supplied_items[0], 10);
    }
    #[test]
    fn supply_protects_inbound_capacity_and_lifetime_counter_overflow_stops_before_mutation() {
        let mut t = town();
        t.npcs[1].held.quantities[2] = 0;
        t.npcs[1].listings[2].as_mut().unwrap().quantity = 0;
        t.npcs[1].reservations.inbound.quantities[2] = 996;
        raw(&mut t, Item::Herb, 1, 1);
        assert_eq!(t.npcs[1].held.quantities[2], 4);
        assert_eq!(t.npcs[1].reservations.inbound.quantities[2], 996);
        raw(&mut t, Item::Herb, 2, 2);
        assert_eq!(t.raw_epochs[2], 2);
        assert_eq!(t.supplied_items[2], 4);
        t.npcs[1].reservations.inbound.quantities[2] = 0;
        t.supplied_items[2] = u128::MAX;
        let held = t.npcs[1].held;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| raw(
                &mut t,
                Item::Herb,
                3,
                3
            )))
            .is_err()
        );
        assert_eq!(t.npcs[1].held.quantities, held.quantities);
        assert_eq!(t.raw_epochs[2], 2);
    }
    #[test]
    fn treasury_sweep_protects_reserved_gold_and_zero_allocation_marks_the_epoch() {
        let mut t = town();
        t.npcs[0].gold = 350;
        t.npcs[0].reservations.gold_trade = 100;
        for (e, s, expected) in [(1, 1, 300), (2, 2, 300)] {
            let c = cmd(e, s);
            context(
                "operator.testnet",
                json!({"merchant_id":"rex","epoch":e.to_string(),"command":c}),
                e * 60_000_000_000 + 1,
            );
            t.sweep_merchant_treasury(MerchantId::Rex, Decimal(e), c);
            assert_eq!(t.npcs[0].gold, expected);
            assert_eq!(t.npcs[0].reservations.gold_trade, 100);
        }
        assert_eq!(t.treasury_burns, 50);
        assert_eq!(t.treasury_epochs[0], 2);
    }
}
impl Allocation {
    pub(super) fn view(&self) -> Value {
        let merchant = self.merchant as usize;
        let ledger = purchases::npc_ledger(merchant, &self.npc);
        if let Some(item) = self.item {
            json!({"kind":"raw_supplied","item_id":item,"merchant_id":self.merchant,"epoch":self.epoch.to_string(),"issued_quantity":self.amount.to_string(),"ledger":ledger})
        } else {
            json!({"kind":"treasury_swept","merchant_id":self.merchant,"epoch":self.epoch.to_string(),"burned_gold":self.amount.to_string(),"ledger":ledger})
        }
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct RawArgs {
    item_id: Item,
    epoch: Decimal,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct SweepArgs {
    merchant_id: MerchantId,
    epoch: Decimal,
    command: Command,
}

#[near]
impl LivingTown {
    pub fn get_source_state(&self) -> Value {
        let _: EmptyArgs = input();
        self.assert_versions();
        self.snapshot(json!({"raw_epochs":Value::Object(ITEM_IDS[..4].iter().zip(self.raw_epochs).map(|(k,v)|((*k).to_owned(),json!(v.to_string()))).collect()),"treasury_epochs":Value::Object(MERCHANTS.iter().zip(self.treasury_epochs).map(|(k,v)|((*k).to_owned(),json!(v.to_string()))).collect())}))
    }
    pub fn allocate_raw_supply(
        &mut self,
        item_id: Item,
        epoch: Decimal,
        command: Command,
    ) -> Value {
        let p: RawArgs = args(&["item_id", "epoch", "command"]);
        require!(
            p.item_id == item_id && p.epoch == epoch && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = env::predecessor_account_id();
        require!(actor == self.operator, "LT:E_UNAUTHORIZED");
        let (digest, replay) = self.command_check(
            &actor,
            "allocate_raw_supply",
            json!({"item_id":item_id,"epoch":epoch,"command":command}),
            &command,
        );
        if let Some(result) = replay {
            return result;
        }
        let slot = item_id as usize;
        require!(slot < 4, "LT:E_RAW_ONLY");
        require!(epoch.0 == self.customer_epoch(), "LT:E_EPOCH_MISMATCH");
        require!(epoch.0 > self.raw_epochs[slot], "LT:E_EPOCH_ALLOCATED");
        let (merchant, target, ceiling) = [
            (MerchantId::Rex, 10u64, 4u64),
            (MerchantId::Bolt, 10, 4),
            (MerchantId::Luna, 20, 8),
            (MerchantId::Bolt, 20, 8),
        ][slot];
        let mut npc = self.npcs[merchant as usize].clone();
        let held = npc.held.quantities[slot];
        let capacity = 1000u64
            .checked_sub(held)
            .and_then(|n| n.checked_sub(npc.reservations.output.quantities[slot]))
            .and_then(|n| n.checked_sub(npc.reservations.inbound.quantities[slot]))
            .unwrap_or_else(|| env::panic_str("LT:E_BALANCE_CAP"));
        let amount = ceiling.min(target.saturating_sub(held)).min(capacity);
        let total = self.supplied_items[slot]
            .checked_add(u128::from(amount))
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        npc.held.quantities[slot] += amount;
        npc.ledger_revision = next(npc.ledger_revision);
        self.npcs[merchant as usize] = npc.clone();
        self.raw_epochs[slot] = epoch.0;
        self.supplied_items[slot] = total;
        self.commit(
            actor,
            command,
            digest,
            Outcome::Source(Box::new(Allocation {
                item: Some(item_id),
                merchant,
                epoch: epoch.0,
                amount,
                npc,
            })),
        )
    }
    pub fn sweep_merchant_treasury(
        &mut self,
        merchant_id: MerchantId,
        epoch: Decimal,
        command: Command,
    ) -> Value {
        let p: SweepArgs = args(&["merchant_id", "epoch", "command"]);
        require!(
            p.merchant_id == merchant_id && p.epoch == epoch && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = env::predecessor_account_id();
        require!(actor == self.operator, "LT:E_UNAUTHORIZED");
        let (digest, replay) = self.command_check(
            &actor,
            "sweep_merchant_treasury",
            json!({"merchant_id":merchant_id,"epoch":epoch,"command":command}),
            &command,
        );
        if let Some(result) = replay {
            return result;
        }
        let index = merchant_id as usize;
        require!(epoch.0 == self.customer_epoch(), "LT:E_EPOCH_MISMATCH");
        require!(
            epoch.0 > self.treasury_epochs[index],
            "LT:E_EPOCH_ALLOCATED"
        );
        let mut npc = self.npcs[index].clone();
        let available = npc
            .gold
            .checked_sub(npc.reservations.gold_trade)
            .unwrap_or_else(|| env::panic_str("LT:E_BALANCE_CAP"));
        let amount = available.saturating_sub(200).min(100);
        let total = self
            .treasury_burns
            .checked_add(u128::from(amount))
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        npc.gold -= amount;
        npc.ledger_revision = next(npc.ledger_revision);
        self.npcs[index] = npc.clone();
        self.treasury_epochs[index] = epoch.0;
        self.treasury_burns = total;
        self.commit(
            actor,
            command,
            digest,
            Outcome::Source(Box::new(Allocation {
                item: None,
                merchant: merchant_id,
                epoch: epoch.0,
                amount,
                npc,
            })),
        )
    }
}
