use super::*;
use ownership::{Outcome, args, next};

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct MarketEvent {
    pub id: u64,
    pub start: u64,
    pub end: u64,
    pub revision: u64,
}
impl MarketEvent {
    pub(super) fn view(&self) -> Value {
        json!({"event_id":self.id.to_string(),"definition_id":"herb_shortage_v1","start_epoch":self.start.to_string(),"end_epoch":self.end.to_string(),"herb_supply_ceiling":"4","revision":self.revision.to_string()})
    }
    pub(super) fn active(&self, epoch: u64) -> bool {
        self.start <= epoch && epoch < self.end
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ScheduleArgs {
    event_id: Decimal,
    definition_id: String,
    start_epoch: Decimal,
    command: Command,
}
impl LivingTown {
    pub(super) fn herb_ceiling(&self, epoch: u64) -> u64 {
        if self.market_events.back().is_some_and(|e| e.active(epoch)) {
            4
        } else {
            8
        }
    }
}
#[near]
impl LivingTown {
    pub fn get_market_events(&self) -> Value {
        let _: EmptyArgs = input();
        self.assert_versions();
        self.snapshot(json!({"items":self.market_events.iter().map(MarketEvent::view).collect::<Vec<_>>(),"pruned_through":self.market_events.front().map_or(self.next_market_event_id-1,|e|e.id-1).to_string()}))
    }
    pub fn schedule_market_event(
        &mut self,
        event_id: Decimal,
        definition_id: String,
        start_epoch: Decimal,
        command: Command,
    ) -> Value {
        let p: ScheduleArgs = args(&["event_id", "definition_id", "start_epoch", "command"]);
        require!(
            p.event_id == event_id
                && p.definition_id == definition_id
                && p.start_epoch == start_epoch
                && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = env::predecessor_account_id();
        require!(actor == self.operator, "LT:E_UNAUTHORIZED");
        let (digest,replay) = self.command_check(&actor,"schedule_market_event",json!({"event_id":event_id,"definition_id":definition_id,"start_epoch":start_epoch,"command":command}),&command);
        if let Some(result) = replay {
            return result;
        }
        require!(definition_id == "herb_shortage_v1", "LT:E_EVENT_DEFINITION");
        require!(event_id.0 == self.next_market_event_id, "LT:E_EVENT_ID");
        let epoch = self.customer_epoch();
        require!(start_epoch.0 == next(epoch), "LT:E_EPOCH_MISMATCH");
        require!(
            self.market_events.back().is_none_or(|e| epoch >= e.end),
            "LT:E_EVENT_PENDING"
        );
        let event = MarketEvent {
            id: event_id.0,
            start: start_epoch.0,
            end: start_epoch
                .0
                .checked_add(5)
                .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW")),
            revision: next(self.market_revision),
        };
        self.next_market_event_id = next(self.next_market_event_id);
        // Keep at most 32 instances total, including any scheduled/active instance.
        if self.market_events.len() == 32 {
            self.market_events.pop_front();
        }
        self.market_events.push_back(event.clone());
        self.commit(actor, command, digest, Outcome::MarketEvent(event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production::tests::{context, town};
    fn schedule(t: &mut LivingTown, epoch: u64, sequence: u64) -> Value {
        let command = Command {
            sequence: Decimal(sequence),
            config_version: Decimal(1),
            valid_until_ns: Decimal(epoch * 60_000_000_000 + 500_000_000_001),
        };
        let id = t.next_market_event_id;
        context(
            "operator.testnet",
            json!({"event_id":id.to_string(),"definition_id":"herb_shortage_v1","start_epoch":(epoch+1).to_string(),"command":command}),
            epoch * 60_000_000_000 + 1,
        );
        t.schedule_market_event(
            Decimal(id),
            "herb_shortage_v1".into(),
            Decimal(epoch + 1),
            command,
        )
    }
    #[test]
    fn schedule_boundaries_and_history_never_reset_sources_or_ids() {
        let mut t = town();
        let before = t.supplied_items;
        schedule(&mut t, 1, 1);
        for (e, limit) in [(1, 8), (2, 4), (6, 4), (7, 8), (10000, 8)] {
            assert_eq!(t.herb_ceiling(e), limit);
        }
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| schedule(&mut t, 2, 2)))
                .is_err()
        );
        assert_eq!(t.next_market_event_id, 2);
        for n in 1..=35 {
            schedule(&mut t, 1 + n * 6, n + 1);
        }
        assert_eq!(t.market_events.len(), 32);
        assert_eq!(t.market_events.front().unwrap().id, 5);
        assert_eq!(t.next_market_event_id, 37);
        assert_eq!(t.supplied_items, before);
    }
    #[test]
    fn shortage_caps_actual_allocation_without_restoring_expired_stock() {
        let mut t = town();
        schedule(&mut t, 1, 1);
        t.npcs[1].held.quantities[2] = 0;
        t.npcs[1].listings[2].as_mut().unwrap().quantity = 0;
        for (epoch, sequence, issued) in [(2, 2, 4), (6, 3, 4), (7, 4, 8)] {
            let c = Command {
                sequence: Decimal(sequence),
                config_version: Decimal(1),
                valid_until_ns: Decimal(epoch * 60_000_000_000 + 500_000_000_001),
            };
            context(
                "operator.testnet",
                json!({"item_id":"herb","epoch":epoch.to_string(),"command":c}),
                epoch * 60_000_000_000 + 1,
            );
            let r = t.allocate_raw_supply(Item::Herb, Decimal(epoch), c);
            assert_eq!(r["data"]["outcome"]["issued_quantity"], issued.to_string());
        }
        assert_eq!(t.supplied_items[2], 16);
        assert_eq!(t.npcs[1].held.quantities[2], 16);
    }
}
