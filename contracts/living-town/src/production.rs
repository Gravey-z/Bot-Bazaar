use super::*;
use ownership::{Outcome, args, next};

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) enum Owner {
    Player(AccountId),
    Merchant(u8),
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn context(actor: &str, payload: Value, time: u64) {
        let mut c = near_sdk::test_utils::VMContextBuilder::new()
            .current_account_id("town.testnet".parse().unwrap())
            .predecessor_account_id(actor.parse().unwrap())
            .signer_account_id(actor.parse().unwrap())
            .account_balance(near_sdk::NearToken::from_near(1000))
            .block_timestamp(time)
            .build();
        c.input = serde_json::to_vec(&payload).unwrap().into();
        near_sdk::testing_env!(c);
    }
    fn command(seq: u64) -> Command {
        Command {
            sequence: Decimal(seq),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        }
    }
    pub(super) fn town() -> LivingTown {
        let digest = config_digest();
        context(
            "town.testnet",
            json!({"owner_account_id":"owner.testnet","operator_account_id":"operator.testnet","merchant_controllers":{"rex":"rex.testnet","luna":"luna.testnet","bolt":"bolt.testnet"},"network_genesis_hash":"11111111111111111111111111111111","config_sha256":digest}),
            1,
        );
        let mut t = LivingTown::initialize_town(
            "owner.testnet".parse().unwrap(),
            Controllers {
                rex: "rex.testnet".parse().unwrap(),
                luna: "luna.testnet".parse().unwrap(),
                bolt: "bolt.testnet".parse().unwrap(),
            },
            "operator.testnet".parse().unwrap(),
            "11111111111111111111111111111111".to_owned(),
            digest,
        );
        context("player.testnet", json!({"command":command(1)}), 2);
        t.register_player(command(1));
        context(
            "player.testnet",
            json!({"name":"Production","command":command(2)}),
            3,
        );
        t.create_shop("Production".to_owned(), command(2));
        t.players
            .get_mut(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap()
            .inventory = Inventory::new([10, 10, 20, 20, 0, 0]);
        t
    }
    pub(super) fn start(t: &mut LivingTown, seq: u64, q: u64) -> Value {
        context(
            "player.testnet",
            json!({"shop_id":"4","recipe_id":"health_potion","recipe_version":"1","quantity":q.to_string(),"expected_shop_revision":"1","command":command(seq)}),
            42,
        );
        t.start_production(
            Decimal(4),
            RecipeId::HealthPotion,
            Decimal(1),
            Decimal(q),
            Decimal(1),
            command(seq),
        )
    }
    #[test]
    fn admission_pins_terms_reserves_output_and_reopens_with_safe_retry() {
        let mut t = town();
        let effect = start(&mut t, 3, 2);
        assert_eq!(
            effect["data"]["outcome"]["job"]["ready_at_ns"],
            "240000000042"
        );
        assert_eq!(t.recipe_inputs_consumed, [2, 0, 4, 0, 0, 0]);
        let player = t
            .players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap();
        assert_eq!(player.inventory.quantities, [8, 10, 16, 20, 0, 0]);
        assert_eq!(player.reservations.output.quantities[4], 2);
        let bytes = near_sdk::borsh::to_vec(&t).unwrap();
        drop(t);
        let mut reopened: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
        let replay = start(&mut reopened, 3, 2);
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(replay["data"]["outcome"], effect["data"]["outcome"]);
        assert_eq!(reopened.next_job_id, 2);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut reopened, 4, 1)))
                .is_err()
        );
        assert_eq!(reopened.next_job_id, 2);
    }
    #[test]
    fn reserved_inputs_and_whole_output_capacity_reject_before_any_write() {
        let mut t = town();
        let account: AccountId = "player.testnet".parse().unwrap();
        let baseline = t.players.get(&account).unwrap().clone();
        for case in 0..5 {
            t.players.insert(account.clone(), baseline.clone());
            let player = t
                .players
                .get_mut(&"player.testnet".parse::<AccountId>().unwrap())
                .unwrap();
            match case {
                0 => player.inventory.quantities[0] = 0,
                1 => player.reservations.listing.quantities[2] = 20,
                2 => player.reservations.trade.quantities[0] = 10,
                3 => {
                    player.inventory.quantities[4] = 999;
                    player.reservations.inbound.quantities[4] = 1;
                }
                _ => player.reservations.output.quantities[4] = 1000,
            }
            let before = player.ledger();
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut t, 3, 1)))
                    .is_err()
            );
            assert_eq!(
                t.players
                    .get(&"player.testnet".parse::<AccountId>().unwrap())
                    .unwrap()
                    .ledger(),
                before
            );
            assert_eq!(t.next_job_id, 1);
            assert_eq!(t.recipe_inputs_consumed, [0; 6]);
        }
    }
    #[test]
    fn npc_controller_uses_merchant_lane_and_protects_listings_and_floors() {
        let mut t = town();
        t.npcs[2].held.quantities[1] = 12;
        t.npcs[2].held.quantities[3] = 24;
        let payload = json!({"shop_id":"3","recipe_id":"iron_tool","recipe_version":"1","quantity":"1","expected_shop_revision":"1","command":command(1)});
        context("bolt.testnet", payload, 42);
        let result = t.start_production(
            Decimal(3),
            RecipeId::IronTool,
            Decimal(1),
            Decimal(1),
            Decimal(1),
            command(1),
        );
        assert_eq!(result["data"]["principal"], "merchant:bolt");
        assert_eq!(t.npcs[2].held.quantities[1], 11);
        assert_eq!(t.npcs[2].held.quantities[3], 22);
        assert_eq!(t.npcs[2].reservations.output.quantities[5], 1);
        assert!(t.commands.get(&"merchant:bolt".to_owned()).is_some());
        assert!(t.commands.get(&"account:bolt.testnet".to_owned()).is_none());
        let ready = t.jobs.get(&1).unwrap().terms.ready_at_ns;
        context("keeper.testnet", json!({"job_id":"1"}), ready);
        t.paused = true;
        t.complete_production(Decimal(1));
        assert_eq!(t.npcs[2].held.quantities[5], 1);
        assert_eq!(t.npcs[2].reservations.output.quantities[5], 0);
        assert_eq!(
            t.commands
                .get(&"merchant:bolt".to_owned())
                .unwrap()
                .sequence,
            1
        );
    }
    #[test]
    fn completion_boundary_permissionless_pause_and_reopen_are_exactly_once() {
        let mut t = town();
        start(&mut t, 3, 2);
        let ready = t.jobs.get(&1).unwrap().terms.ready_at_ns;
        let before = near_sdk::borsh::to_vec(&t).unwrap();
        context("keeper.testnet", json!({"job_id":"1"}), ready - 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                || t.complete_production(Decimal(1))
            ))
            .is_err()
        );
        assert_eq!(near_sdk::borsh::to_vec(&t).unwrap(), before);
        context("keeper.testnet", json!({"job_id":"1"}), ready);
        t.paused = true;
        let applied = t.complete_production(Decimal(1));
        let p = t
            .players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap();
        assert_eq!(p.inventory.quantities[4], 2);
        assert_eq!(p.reservations.output.quantities[4], 0);
        assert_eq!(p.gold, 100);
        assert!(t.active_jobs.get(&4).is_none());
        assert_eq!(t.completed_outputs[4], 2);
        assert_eq!(
            t.commands
                .get(&"account:player.testnet".to_owned())
                .unwrap()
                .sequence,
            3
        );
        let bytes = near_sdk::borsh::to_vec(&t).unwrap();
        drop(t);
        let mut reopened: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
        context("other.testnet", json!({"job_id":"1"}), ready + 1);
        let replay = reopened.complete_production(Decimal(1));
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(replay["data"]["outcome"], applied["data"]["outcome"]);
        assert_eq!(near_sdk::borsh::to_vec(&reopened).unwrap(), bytes);
    }
    #[test]
    fn valid_inventory_changes_cannot_strand_reserved_output_at_the_cap() {
        let mut t = town();
        start(&mut t, 3, 3);
        let ready = t.jobs.get(&1).unwrap().terms.ready_at_ns;
        let p = t
            .players
            .get_mut(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap();
        // Controlled future inventory/listing changes respect the same capacity
        // promise; this does not claim an unimplemented product purchase path.
        p.inventory.quantities[4] = 997;
        p.reservations.listing.quantities[4] = 20;
        p.reservations.trade.quantities[4] = 19;
        p.gold = 50;
        context("keeper.testnet", json!({"job_id":"1"}), ready);
        t.complete_production(Decimal(1));
        let p = t
            .players
            .get(&"player.testnet".parse::<AccountId>().unwrap())
            .unwrap();
        assert_eq!(p.inventory.quantities[4], 1000);
        assert_eq!(p.reservations.output.quantities[4], 0);
        assert_eq!(p.ledger()["inventory"]["available"]["health_potion"], "961");
        assert_eq!(p.gold, 50);
    }
    #[test]
    fn completed_ring_prunes_by_completion_without_removing_an_older_running_job() {
        let mut t = town();
        start(&mut t, 3, 1);
        let template = t.jobs.get(&1).unwrap().clone();
        // Synthetic job admission isolates retention, not economic solvability.
        for id in 2..=258 {
            let mut j = template.clone();
            j.id = id;
            j.shop_id = 1;
            j.owner = Owner::Merchant(0);
            t.jobs.insert(id, j);
            t.active_jobs.insert(1, id);
            t.next_job_id = id + 1;
            t.npcs[0].reservations.output.quantities[4] = 1;
            context(
                "keeper.testnet",
                json!({"job_id":id.to_string()}),
                template.terms.ready_at_ns,
            );
            t.complete_production(Decimal(id));
        }
        assert_eq!(t.completed_jobs.len(), 256);
        assert_eq!(t.pruned_jobs_through, 2);
        assert!(t.jobs.get(&2).is_none());
        assert!(t.jobs.get(&1).unwrap().completed_at_ns.is_none());
        assert_eq!(t.active_jobs.get(&4), Some(&1));
        context(
            "keeper.testnet",
            json!({"job_id":"2"}),
            template.terms.ready_at_ns + 1,
        );
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                || t.complete_production(Decimal(2))
            ))
            .is_err()
        );
        assert_eq!(t.npcs[0].held.quantities[4], 257);
    }
}
impl Owner {
    pub(super) fn view(&self) -> Value {
        match self {
            Self::Player(a) => json!({"kind":"player","account_id":a}),
            Self::Merchant(i) => json!({"kind":"merchant","merchant_id":MERCHANTS[*i as usize]}),
        }
    }
    pub(super) fn principal(&self) -> String {
        match self {
            Self::Player(a) => format!("account:{a}"),
            Self::Merchant(i) => format!("merchant:{}", MERCHANTS[*i as usize]),
        }
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Job {
    pub id: u64,
    pub shop_id: u64,
    pub owner: Owner,
    pub terms: ProductionTerms,
    pub command_sequence: u64,
    pub completed_at_ns: Option<u64>,
    pub completion_revision: u64,
    pub completion_ledger: Option<ValueLedger>,
}
impl Job {
    pub(super) fn view(&self) -> Value {
        let mut value = self.terms.view();
        let row = value.as_object_mut().expect("terms");
        row.insert("job_id".to_owned(), json!(self.id.to_string()));
        row.insert("shop_id".to_owned(), json!(self.shop_id.to_string()));
        row.insert("owner".to_owned(), self.owner.view());
        row.insert(
            "completed_at_ns".to_owned(),
            self.completed_at_ns
                .map(|n| json!(n.to_string()))
                .unwrap_or(Value::Null),
        );
        row.insert(
            "status".to_owned(),
            json!(if self.completed_at_ns.is_some() {
                "completed"
            } else {
                "running"
            }),
        );
        row.insert(
            "start_command_sequence".to_owned(),
            json!(self.command_sequence.to_string()),
        );
        row.insert(
            "revision".to_owned(),
            json!(if self.completed_at_ns.is_some() {
                "2"
            } else {
                "1"
            }),
        );
        value
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Started {
    pub job: Job,
    pub ledger: ValueLedger,
}
// Persist a compact typed ledger effect, never a JSON blob in command history.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct ValueLedger {
    owner: Owner,
    gold: u64,
    held: Inventory,
    revision: u64,
    reservations: purchases::Reservations,
}
impl Started {
    pub(super) fn view(&self) -> Value {
        json!({"kind":"production_started","job":self.job.view(),"ledger":purchases::ledger(self.ledger.owner.view(),self.ledger.gold,self.ledger.held,self.ledger.revision,&self.ledger.reservations)})
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct StartArgs {
    shop_id: Decimal,
    recipe_id: RecipeId,
    recipe_version: Decimal,
    quantity: Decimal,
    expected_shop_revision: Decimal,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct CompleteArgs {
    job_id: Decimal,
}

fn credit(held: &mut Inventory, r: &mut purchases::Reservations, terms: &ProductionTerms) {
    let slot = terms.output_item as usize;
    let remaining = r.output.quantities[slot]
        .checked_sub(terms.output_quantity)
        .unwrap_or_else(|| env::panic_str("LT:E_INVALID_RESERVATION"));
    let amount = held.quantities[slot]
        .checked_add(terms.output_quantity)
        .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
    require!(
        amount
            .checked_add(remaining)
            .and_then(|v| v.checked_add(r.inbound.quantities[slot]))
            .is_some_and(|v| v <= 1000),
        "LT:E_BALANCE_CAP"
    );
    held.quantities[slot] = amount;
    r.output.quantities[slot] = remaining;
}

impl LivingTown {
    fn completion_result(&self, job: &Job, replayed: bool) -> Value {
        let l = job.completion_ledger.as_ref().expect("completed ledger");
        self.snapshot(json!({"principal":null,"command_sequence":null,"payload_sha256":null,"replayed":replayed,"effect_revision":job.completion_revision.to_string(),"effect_event_sequence":job.completion_revision.to_string(),"outcome":{"kind":"production_completed","job":job.view(),"ledger":purchases::ledger(l.owner.view(),l.gold,l.held,l.revision,&l.reservations)}}))
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PageArgs {
    shop_id: Decimal,
    status: String,
    after_id: Option<Decimal>,
    limit: Decimal,
    expected_market_revision: Decimal,
}

fn consume(
    held: &mut Inventory,
    r: &mut purchases::Reservations,
    terms: &ProductionTerms,
    npc: bool,
) {
    let slot = terms.output_item as usize;
    require!(
        held.quantities[slot]
            .checked_add(r.output.quantities[slot])
            .and_then(|n| n.checked_add(r.inbound.quantities[slot]))
            .and_then(|n| n.checked_add(terms.output_quantity))
            .is_some_and(|n| n <= 1000),
        "LT:E_BALANCE_CAP"
    );
    for (i, item) in ITEM_IDS.iter().enumerate() {
        let n = terms.inputs_consumed.quantities[i];
        require!(
            held.quantities[i]
                .checked_sub(r.listing.quantities[i])
                .and_then(|v| v.checked_sub(r.trade.quantities[i]))
                .is_some_and(|v| v >= n),
            "LT:E_INSUFFICIENT_INPUTS"
        );
        if npc && i < 4 && n > 0 {
            let floor: u64 = config()["economy"]["materials"][*item]["floor"]
                .as_str()
                .expect("floor")
                .parse()
                .expect("floor integer");
            require!(
                held.quantities[i]
                    .checked_sub(n)
                    .and_then(|v| v.checked_sub(r.trade.quantities[i]))
                    .is_some_and(|v| v >= floor),
                "LT:E_INSUFFICIENT_INPUTS"
            );
        }
    }
    for i in 0..6 {
        held.quantities[i] -= terms.inputs_consumed.quantities[i];
    }
    r.output.quantities[slot] += terms.output_quantity;
}

#[near]
impl LivingTown {
    pub fn complete_production(&mut self, job_id: Decimal) -> Value {
        let p: CompleteArgs = args(&["job_id"]);
        require!(p.job_id == job_id && job_id.0 > 0, "LT:E_INVALID_ARGUMENT");
        self.assert_versions();
        let mut job = self.jobs.get(&job_id.0).cloned().unwrap_or_else(|| {
            env::panic_str(if job_id.0 < self.next_job_id {
                "LT:E_JOB_PRUNED"
            } else {
                "LT:E_JOB_NOT_FOUND"
            })
        });
        if job.completed_at_ns.is_some() {
            return self.completion_result(&job, true);
        }
        require!(
            env::block_timestamp() >= job.terms.ready_at_ns,
            "LT:E_PRODUCTION_NOT_READY"
        );
        require!(
            self.active_jobs.get(&job.shop_id) == Some(&job.id),
            "LT:E_INVALID_PRODUCTION_SLOT"
        );
        let ledger = match &job.owner {
            Owner::Player(a) => {
                let mut player = self.players.get(a).expect("owner").clone();
                let mut shop = self.shops.get(&job.shop_id).expect("shop").clone();
                credit(&mut player.inventory, &mut player.reservations, &job.terms);
                player.ledger_revision = next(player.ledger_revision);
                shop.revision = next(shop.revision);
                let l = ValueLedger {
                    owner: job.owner.clone(),
                    gold: player.gold,
                    held: player.inventory,
                    revision: player.ledger_revision,
                    reservations: player.reservations.clone(),
                };
                self.players.insert(a.clone(), player);
                self.shops.insert(shop.id, shop);
                l
            }
            Owner::Merchant(i) => {
                let mut npc = self.npcs[*i as usize].clone();
                credit(&mut npc.held, &mut npc.reservations, &job.terms);
                npc.ledger_revision = next(npc.ledger_revision);
                npc.production_revision = next(npc.production_revision);
                let mut promises = npc.reservations.clone();
                for (i, l) in npc.listings.iter().enumerate() {
                    promises.listing.quantities[i] = l.as_ref().map_or(0, |l| l.quantity);
                }
                let l = ValueLedger {
                    owner: job.owner.clone(),
                    gold: npc.gold,
                    held: npc.held,
                    revision: npc.ledger_revision,
                    reservations: promises,
                };
                self.npcs[*i as usize] = npc;
                l
            }
        };
        let slot = job.terms.output_item as usize;
        self.completed_outputs[slot] = self.completed_outputs[slot]
            .checked_add(u128::from(job.terms.output_quantity))
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        self.market_revision = next(self.market_revision);
        job.completed_at_ns = Some(env::block_timestamp());
        job.completion_revision = self.market_revision;
        job.completion_ledger = Some(ledger);
        self.active_jobs.remove(&job.shop_id);
        self.jobs.insert(job.id, job.clone());
        self.completed_jobs.push_back(job.id);
        if self.completed_jobs.len() > 256 {
            let old = self.completed_jobs.pop_front().expect("completed");
            self.jobs.remove(&old);
            self.pruned_jobs_through = self.pruned_jobs_through.max(old);
        }
        self.persist_economic_state(false);
        let result = self.completion_result(&job, false);
        let event = json!({"standard":"bot_bazaar_living_town","version":"2.0.0","event":"complete_production","data":[{"contract_id":env::current_account_id(),"config_version":self.config_version.to_string(),"event_sequence":self.market_revision.to_string(),"market_revision":self.market_revision.to_string(),"block_height":env::block_height().to_string(),"block_timestamp_ns":env::block_timestamp().to_string(),"predecessor_account_id":env::predecessor_account_id(),"principal":null,"command_sequence":null,"payload_sha256":null,"outcome":result["data"]["outcome"]}]});
        let encoded = serde_json::to_string(&event).expect("event");
        require!(encoded.len() <= 32768, "LT:E_STORAGE_CAPACITY");
        env::log_str(&format!("EVENT_JSON:{encoded}"));
        result
    }
    pub fn start_production(
        &mut self,
        shop_id: Decimal,
        recipe_id: RecipeId,
        recipe_version: Decimal,
        quantity: Decimal,
        expected_shop_revision: Decimal,
        command: Command,
    ) -> Value {
        let p: StartArgs = args(&[
            "shop_id",
            "recipe_id",
            "recipe_version",
            "quantity",
            "expected_shop_revision",
            "command",
        ]);
        require!(
            p.shop_id == shop_id
                && p.recipe_id == recipe_id
                && p.recipe_version == recipe_version
                && p.quantity == quantity
                && p.expected_shop_revision == expected_shop_revision
                && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = env::predecessor_account_id();
        let owner = if (1..=3).contains(&shop_id.0) {
            let i = (shop_id.0 - 1) as usize;
            require!(actor == self.controllers[i], "LT:E_NOT_OWNER");
            Owner::Merchant(i as u8)
        } else {
            let shop = self
                .shops
                .get(&shop_id.0)
                .unwrap_or_else(|| env::panic_str("LT:E_INVALID_ARGUMENT"));
            require!(shop.owner == actor, "LT:E_NOT_OWNER");
            Owner::Player(actor.clone())
        };
        let (digest,replay)=self.command_check(&actor,"start_production",json!({"shop_id":shop_id,"recipe_id":recipe_id,"recipe_version":recipe_version,"quantity":quantity,"expected_shop_revision":expected_shop_revision,"command":command}),&command);
        if let Some(value) = replay {
            return value;
        }
        require!(
            !self.active_jobs.contains_key(&shop_id.0),
            "LT:E_NO_PRODUCTION_SLOT"
        );
        let terms = Recipe::versioned(recipe_id, recipe_version.0).terms(
            self.config_version,
            quantity.0,
            env::block_timestamp(),
        );
        let ledger = match &owner {
            Owner::Player(a) => {
                let mut shop = self.shops.get(&shop_id.0).expect("shop").clone();
                require!(shop.revision == expected_shop_revision.0, "LT:E_STALE_SHOP");
                let mut player = self.players.get(a).expect("shop owner").clone();
                consume(
                    &mut player.inventory,
                    &mut player.reservations,
                    &terms,
                    false,
                );
                player.ledger_revision = next(player.ledger_revision);
                shop.revision = next(shop.revision);
                let ledger = ValueLedger {
                    owner: owner.clone(),
                    gold: player.gold,
                    held: player.inventory,
                    revision: player.ledger_revision,
                    reservations: player.reservations.clone(),
                };
                self.players.insert(a.clone(), player);
                self.shops.insert(shop.id, shop);
                ledger
            }
            Owner::Merchant(i) => {
                let mut npc = self.npcs[*i as usize].clone();
                require!(
                    npc.production_revision == expected_shop_revision.0,
                    "LT:E_STALE_SHOP"
                );
                // Active raw listings are reservations as well as explicit promises.
                let mut promises = npc.reservations.clone();
                for (i, l) in npc.listings.iter().enumerate() {
                    promises.listing.quantities[i] = l.as_ref().map_or(0, |l| l.quantity);
                }
                consume(&mut npc.held, &mut promises, &terms, true);
                npc.reservations.output = promises.output;
                npc.ledger_revision = next(npc.ledger_revision);
                npc.production_revision = next(npc.production_revision);
                let ledger = ValueLedger {
                    owner: owner.clone(),
                    gold: npc.gold,
                    held: npc.held,
                    revision: npc.ledger_revision,
                    reservations: promises,
                };
                self.npcs[*i as usize] = npc;
                ledger
            }
        };
        for i in 0..6 {
            self.recipe_inputs_consumed[i] = self.recipe_inputs_consumed[i]
                .checked_add(u128::from(terms.inputs_consumed.quantities[i]))
                .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        }
        let job = Job {
            id: self.next_job_id,
            shop_id: shop_id.0,
            owner,
            terms,
            command_sequence: command.sequence.0,
            completed_at_ns: None,
            completion_revision: 0,
            completion_ledger: None,
        };
        self.next_job_id = next(job.id);
        self.active_jobs.insert(shop_id.0, job.id);
        self.jobs.insert(job.id, job.clone());
        self.commit(
            actor,
            command,
            digest,
            Outcome::Started(Box::new(Started { job, ledger })),
        )
    }
    pub fn get_production_jobs(
        &self,
        shop_id: Decimal,
        status: String,
        after_id: Option<Decimal>,
        limit: Decimal,
        expected_market_revision: Decimal,
    ) -> Value {
        let p: PageArgs = args(&[
            "shop_id",
            "status",
            "after_id",
            "limit",
            "expected_market_revision",
        ]);
        require!(
            p.shop_id == shop_id
                && p.status == status
                && p.after_id == after_id
                && p.limit == limit
                && p.expected_market_revision == expected_market_revision,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        require!(
            shop_id.0 > 0 && ((shop_id.0 <= 3) || self.shops.contains_key(&shop_id.0)),
            "LT:E_INVALID_ARGUMENT"
        );
        require!(
            (1..=50).contains(&limit.0)
                && ["all", "running", "completed"].contains(&status.as_str()),
            "LT:E_INVALID_ARGUMENT"
        );
        require!(
            expected_market_revision.0 == self.market_revision,
            "LT:E_STALE_MARKET"
        );
        let mut ids: Vec<u64> = self.completed_jobs.iter().copied().collect();
        if let Some(id) = self.active_jobs.get(&shop_id.0) {
            ids.push(*id);
        }
        ids.sort_unstable();
        let mut eligible = ids
            .into_iter()
            .filter_map(|id| self.jobs.get(&id))
            .filter(|j| {
                j.shop_id == shop_id.0
                    && after_id.is_none_or(|a| j.id > a.0)
                    && (status == "all" || (status == "completed") == j.completed_at_ns.is_some())
            });
        let rows: Vec<_> = eligible.by_ref().take(limit.0 as usize).collect();
        let more = eligible.next().is_some();
        let cursor = rows.last().map(|j| j.id).or(after_id.map(|a| a.0));
        let items: Vec<_> = rows.iter().map(|j| j.view()).collect();
        self.snapshot(json!({"items":items,"next_after_id":cursor.map(|id|id.to_string()),"has_more":more,"history_gap":self.pruned_jobs_through>0,"pruned_through":self.pruned_jobs_through.to_string()}))
    }
}

#[cfg(test)]
#[path = "production_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "production_fault_tests.rs"]
mod fault_tests;
