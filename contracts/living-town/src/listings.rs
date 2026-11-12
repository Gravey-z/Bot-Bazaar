use super::*;
use near_sdk::serde::Serialize;
use ownership::{Outcome, args, next};
use production::Owner;

pub(crate) const ITEMS: [Item; 6] = [
    Item::Crystal,
    Item::Wood,
    Item::Herb,
    Item::Iron,
    Item::HealthPotion,
    Item::IronTool,
];
#[near(serializers=[borsh])]
#[derive(Clone)]
pub(crate) struct Change {
    pub owner: Owner,
    shop_id: u64,
    item: Item,
    listing: Listing,
    gold: u64,
    held: Inventory,
    revision: u64,
    reservations: purchases::Reservations,
    pub cancelled: bool,
}
pub(crate) fn view(shop_id: u64, item: Item, listing: &Listing, owner: &Owner) -> Value {
    json!({"listing_id":listing.id.to_string(),"shop_id":shop_id.to_string(),"owner":owner.view(),"item_id":item,"remaining_quantity":listing.quantity.to_string(),"unit_price":listing.unit_price.to_string(),"revision":listing.revision.to_string(),"active":listing.quantity>0})
}
impl Change {
    pub(super) fn view(&self) -> Value {
        json!({"kind":if self.cancelled {"listing_cancelled"} else {"listing_set"},"listing":view(self.shop_id,self.item,&self.listing,&self.owner),"ledger":purchases::ledger(self.owner.view(),self.gold,self.held,self.revision,&self.reservations)})
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct SetArgs {
    shop_id: Decimal,
    item_id: Item,
    quantity: Decimal,
    unit_price: Decimal,
    expected_listing_revision: Option<Decimal>,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct CancelArgs {
    listing_id: Decimal,
    expected_listing_revision: Decimal,
    command: Command,
}
/// One entry is a complete listing mutation. Only one merchant's shop is
/// permitted in a batch, and item IDs must be distinct.
#[derive(Clone, Deserialize, Serialize, near_sdk::NearSchema, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct BatchListingUpdate {
    shop_id: Decimal,
    item_id: Item,
    quantity: Decimal,
    unit_price: Decimal,
    expected_listing_revision: Option<Decimal>,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BatchListingArgs {
    updates: Vec<BatchListingUpdate>,
    command: Command,
}
/// One command checkpoint and one replayable result for the whole batch.
#[near(serializers=[borsh])]
#[derive(Clone)]
pub(crate) struct BatchListing {
    pub owner: Owner,
    entries: Vec<(u64, Item, Listing)>,
    final_change: Change,
}
impl BatchListing {
    pub(super) fn view(&self) -> Value {
        json!({
            "kind": "listings_set",
            "listings": self.entries.iter().map(|(shop,item,listing)|
                view(*shop, *item, listing, &self.owner)
            ).collect::<Vec<_>>(),
            "ledger": self.final_change.view()["ledger"],
        })
    }
}
impl LivingTown {
    pub(super) fn listing_owner(&self, shop_id: u64) -> Owner {
        if (1..=3).contains(&shop_id) {
            Owner::Merchant((shop_id - 1) as u8)
        } else {
            Owner::Player(
                self.shops
                    .get(&shop_id)
                    .unwrap_or_else(|| env::panic_str("LT:E_LISTING_NOT_FOUND"))
                    .owner
                    .clone(),
            )
        }
    }
    fn listing_authority(&self, owner: &Owner) {
        let actor = env::predecessor_account_id();
        require!(
            match owner {
                Owner::Player(id) => *id == actor,
                Owner::Merchant(i) => self.controllers[*i as usize] == actor,
            },
            "LT:E_NOT_OWNER"
        );
    }
    pub(super) fn listing_row(&self, id: u64) -> Option<(u64, Item, Listing)> {
        let &(shop, slot) = self.listing_index.get(&id)?;
        let listing = if shop <= 3 {
            self.npcs[(shop - 1) as usize].listings[slot as usize].clone()
        } else {
            self.player_listings.get(&id).cloned()
        }?;
        Some((shop, ITEMS[slot as usize], listing))
    }
    fn replace_listing(
        &mut self,
        shop_id: u64,
        item: Item,
        listing: Listing,
        cancelled: bool,
    ) -> Change {
        let owner = self.listing_owner(shop_id);
        let (gold, held, revision, reservations) = match &owner {
            Owner::Player(id) => {
                let mut p = self.players.get(id).expect("player").clone();
                p.reservations.listing.quantities[item as usize] = listing.quantity;
                p.ledger_revision = next(p.ledger_revision);
                let values = (
                    p.gold,
                    p.inventory,
                    p.ledger_revision,
                    p.reservations.clone(),
                );
                self.players.insert(id.clone(), p);
                self.player_listings.insert(listing.id, listing.clone());
                values
            }
            Owner::Merchant(i) => {
                let npc = &mut self.npcs[*i as usize];
                npc.listings[item as usize] = Some(listing.clone());
                npc.ledger_revision = next(npc.ledger_revision);
                let mut reservations = npc.reservations.clone();
                for (slot, row) in npc.listings.iter().enumerate() {
                    reservations.listing.quantities[slot] = row.as_ref().map_or(0, |l| l.quantity);
                }
                (npc.gold, npc.held, npc.ledger_revision, reservations)
            }
        };
        Change {
            owner,
            shop_id,
            item,
            listing,
            gold,
            held,
            revision,
            reservations,
            cancelled,
        }
    }
}

#[near]
impl LivingTown {
    pub fn set_listing(
        &mut self,
        shop_id: Decimal,
        item_id: Item,
        quantity: Decimal,
        unit_price: Decimal,
        expected_listing_revision: Option<Decimal>,
        command: Command,
    ) -> Value {
        let p: SetArgs = args(&[
            "shop_id",
            "item_id",
            "quantity",
            "unit_price",
            "expected_listing_revision",
            "command",
        ]);
        require!(
            p.shop_id == shop_id
                && p.item_id == item_id
                && p.quantity == quantity
                && p.unit_price == unit_price
                && p.expected_listing_revision == expected_listing_revision
                && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let owner = self.listing_owner(shop_id.0);
        self.listing_authority(&owner);
        let actor = env::predecessor_account_id();
        let (digest,replay)=self.command_check(&actor,"set_listing",json!({"shop_id":shop_id,"item_id":item_id,"quantity":quantity,"unit_price":unit_price,"expected_listing_revision":expected_listing_revision,"command":command}),&command);
        if let Some(effect) = replay {
            return effect;
        }
        require!(
            quantity.0 <= 100 && (1..=100).contains(&unit_price.0),
            "LT:E_INVALID_LISTING_TERMS"
        );
        let slot = item_id as usize;
        let key = (shop_id.0, slot as u8);
        let old = self
            .listing_slots
            .get(&key)
            .and_then(|id| self.listing_row(*id).map(|(_, _, l)| l));
        require!(
            old.as_ref().map(|l| Decimal(l.revision)) == expected_listing_revision,
            "LT:E_STALE_LISTING"
        );
        let (held, trade) = match &owner {
            Owner::Player(id) => {
                require!(slot >= 4, "LT:E_PLAYER_PRODUCTS_ONLY");
                let p = self.players.get(id).expect("player");
                (
                    p.inventory.quantities[slot],
                    p.reservations.trade.quantities[slot],
                )
            }
            Owner::Merchant(i) => {
                let npc = &self.npcs[*i as usize];
                if slot < 4 {
                    let cfg = config();
                    let row = &cfg["economy"]["materials"][ITEM_IDS[slot]];
                    let lo = row["minPrice"].as_str().unwrap().parse::<u64>().unwrap();
                    let hi = row["maxPrice"].as_str().unwrap().parse::<u64>().unwrap();
                    require!((lo..=hi).contains(&unit_price.0), "LT:E_PRICE_BAND");
                }
                (
                    npc.held.quantities[slot],
                    npc.reservations.trade.quantities[slot],
                )
            }
        };
        require!(
            quantity.0 <= held.saturating_sub(trade),
            "LT:E_INSUFFICIENT_AVAILABLE_STOCK"
        );
        let listing = if let Some(old) = old {
            Listing {
                id: old.id,
                quantity: quantity.0,
                unit_price: unit_price.0,
                revision: next(old.revision),
            }
        } else {
            let id = self.next_listing_id;
            self.next_listing_id = next(id);
            self.listing_index.insert(id, key);
            self.listing_slots.insert(key, id);
            Listing {
                id,
                quantity: quantity.0,
                unit_price: unit_price.0,
                revision: 1,
            }
        };
        let change = self.replace_listing(shop_id.0, item_id, listing, false);
        self.commit(actor, command, digest, Outcome::Listing(Box::new(change)))
    }
    /// Atomic, bounded merchant listing update. One command sequence, one
    /// command digest, and one durable on-chain result for all child changes.
    pub fn batch_set_listings(
        &mut self,
        updates: Vec<BatchListingUpdate>,
        command: Command,
    ) -> Value {
        let p: BatchListingArgs = args(&["updates", "command"]);
        require!(
            p.updates == updates && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        require!(
            (1..=ITEMS.len()).contains(&updates.len()),
            "LT:E_INVALID_ARGUMENT"
        );
        let shop_id = updates[0].shop_id.0;
        require!((1..=3).contains(&shop_id), "LT:E_INVALID_ARGUMENT");
        let owner = self.listing_owner(shop_id);
        self.listing_authority(&owner);
        let mut seen = [false; 6];
        for u in &updates {
            require!(u.shop_id.0 == shop_id, "LT:E_NOT_OWNER");
            let slot = u.item_id as usize;
            require!(!seen[slot], "LT:E_INVALID_ARGUMENT");
            seen[slot] = true;
        }
        let actor = env::predecessor_account_id();
        let (digest, replay) = self.command_check(
            &actor,
            "batch_set_listings",
            json!({"updates": updates, "command": command}),
            &command,
        );
        if let Some(effect) = replay {
            return effect;
        }
        let mut entries = Vec::with_capacity(updates.len());
        let mut final_change: Option<Change> = None;
        for u in updates {
            require!(
                u.quantity.0 <= 100 && (1..=100).contains(&u.unit_price.0),
                "LT:E_INVALID_LISTING_TERMS"
            );
            let slot = u.item_id as usize;
            let key = (shop_id, slot as u8);
            let old = self
                .listing_slots
                .get(&key)
                .and_then(|id| self.listing_row(*id).map(|(_, _, l)| l));
            require!(
                old.as_ref().map(|l| Decimal(l.revision)) == u.expected_listing_revision,
                "LT:E_STALE_LISTING"
            );
            let npc = &self.npcs[(shop_id - 1) as usize];
            if slot < 4 {
                let cfg = config();
                let row = &cfg["economy"]["materials"][ITEM_IDS[slot]];
                let lo = row["minPrice"].as_str().unwrap().parse::<u64>().unwrap();
                let hi = row["maxPrice"].as_str().unwrap().parse::<u64>().unwrap();
                require!((lo..=hi).contains(&u.unit_price.0), "LT:E_PRICE_BAND");
            }
            require!(
                u.quantity.0
                    <= npc.held.quantities[slot]
                        .saturating_sub(npc.reservations.trade.quantities[slot]),
                "LT:E_INSUFFICIENT_AVAILABLE_STOCK"
            );
            let listing = if let Some(old) = old {
                Listing {
                    id: old.id,
                    quantity: u.quantity.0,
                    unit_price: u.unit_price.0,
                    revision: next(old.revision),
                }
            } else {
                let id = self.next_listing_id;
                self.next_listing_id = next(id);
                self.listing_index.insert(id, key);
                self.listing_slots.insert(key, id);
                Listing {
                    id,
                    quantity: u.quantity.0,
                    unit_price: u.unit_price.0,
                    revision: 1,
                }
            };
            let change = self.replace_listing(shop_id, u.item_id, listing.clone(), false);
            entries.push((shop_id, u.item_id, listing));
            final_change = Some(change);
        }
        self.commit(
            actor,
            command,
            digest,
            Outcome::ListingBatch(Box::new(BatchListing {
                owner,
                entries,
                final_change: final_change.expect("nonempty batch"),
            })),
        )
    }
    pub fn cancel_listing(
        &mut self,
        listing_id: Decimal,
        expected_listing_revision: Decimal,
        command: Command,
    ) -> Value {
        let p: CancelArgs = args(&["listing_id", "expected_listing_revision", "command"]);
        require!(
            p.listing_id == listing_id
                && p.expected_listing_revision == expected_listing_revision
                && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let (shop, item, mut listing) = self
            .listing_row(listing_id.0)
            .unwrap_or_else(|| env::panic_str("LT:E_LISTING_NOT_FOUND"));
        self.listing_authority(&self.listing_owner(shop));
        let actor = env::predecessor_account_id();
        let (digest,replay)=self.command_check(&actor,"cancel_listing",json!({"listing_id":listing_id,"expected_listing_revision":expected_listing_revision,"command":command}),&command);
        if let Some(effect) = replay {
            return effect;
        }
        require!(
            listing.revision == expected_listing_revision.0,
            "LT:E_STALE_LISTING"
        );
        require!(listing.quantity > 0, "LT:E_LISTING_INACTIVE");
        listing.quantity = 0;
        listing.revision = next(listing.revision);
        let change = self.replace_listing(shop, item, listing, true);
        self.commit(actor, command, digest, Outcome::Listing(Box::new(change)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production::tests::{context, start, town};
    fn command(seq: u64) -> Command {
        Command {
            sequence: Decimal(seq),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        }
    }
    fn set(
        t: &mut LivingTown,
        target: (&str, u64),
        item: Item,
        q: u64,
        price: u64,
        revision: Option<u64>,
        seq: u64,
    ) -> Value {
        let (actor, shop) = target;
        let revision = revision.map(Decimal);
        context(
            actor,
            json!({"shop_id":shop.to_string(),"item_id":item,"quantity":q.to_string(),"unit_price":price.to_string(),"expected_listing_revision":revision,"command":command(seq)}),
            400_000_000_000,
        );
        t.set_listing(
            Decimal(shop),
            item,
            Decimal(q),
            Decimal(price),
            revision,
            command(seq),
        )
    }
    fn cancel(t: &mut LivingTown, actor: &str, id: u64, revision: u64, seq: u64) -> Value {
        context(
            actor,
            json!({"listing_id":id.to_string(),"expected_listing_revision":revision.to_string(),"command":command(seq)}),
            400_000_000_000,
        );
        t.cancel_listing(Decimal(id), Decimal(revision), command(seq))
    }
    fn funded() -> LivingTown {
        let mut t = town();
        start(&mut t, 3, 3);
        let ready = t.jobs.get(&1).unwrap().terms.ready_at_ns;
        context("keeper.testnet", json!({"job_id":"1"}), ready);
        t.complete_production(Decimal(1));
        t
    }
    fn state(t: &LivingTown) -> Value {
        let id: AccountId = "player.testnet".parse().unwrap();
        json!({"root":near_sdk::borsh::to_vec(t).unwrap(),"ledger":t.players.get(&id).unwrap().ledger(),"npcs":near_sdk::borsh::to_vec(&t.npcs).unwrap(),"row":t.listing_row(5).map(|(_,_,r)|near_sdk::borsh::to_vec(&r).unwrap()),"slot":t.listing_slots.get(&(4,4)),"command":t.commands.get(&"account:player.testnet".to_owned()).map(|c|near_sdk::borsh::to_vec(c).unwrap())})
    }
    #[test]
    fn replacement_cancellation_and_reopen_preserve_identity_and_original_acknowledgement() {
        let mut t = funded();
        let first = set(
            &mut t,
            ("player.testnet", 4),
            Item::HealthPotion,
            2,
            18,
            None,
            4,
        );
        assert_eq!(first["data"]["outcome"]["listing"]["listing_id"], "5");
        assert_eq!(
            first["data"]["outcome"]["ledger"]["inventory"]["available"]["health_potion"],
            "1"
        );
        let stable = state(&t);
        assert_eq!(
            set(
                &mut t,
                ("player.testnet", 4),
                Item::HealthPotion,
                2,
                18,
                None,
                4
            )["data"]["replayed"],
            true
        );
        assert_eq!(state(&t), stable);
        set(
            &mut t,
            ("player.testnet", 4),
            Item::HealthPotion,
            3,
            20,
            Some(1),
            5,
        );
        let result = set(
            &mut t,
            ("player.testnet", 4),
            Item::HealthPotion,
            1,
            19,
            Some(2),
            6,
        );
        assert_eq!(
            result["data"]["outcome"]["ledger"]["inventory"]["available"]["health_potion"],
            "2"
        );
        t.paused = true;
        let released = cancel(&mut t, "player.testnet", 5, 3, 7);
        assert_eq!(
            released["data"]["outcome"]["ledger"]["inventory"]["available"]["health_potion"],
            "3"
        );
        let bytes = near_sdk::borsh::to_vec(&t).unwrap();
        drop(t);
        let mut t: LivingTown = near_sdk::borsh::from_slice(&bytes).unwrap();
        let stable = state(&t);
        assert_eq!(
            cancel(&mut t, "player.testnet", 5, 3, 7)["data"]["outcome"],
            released["data"]["outcome"]
        );
        assert_eq!(state(&t), stable);
        t.paused = false;
        let result = set(
            &mut t,
            ("player.testnet", 4),
            Item::HealthPotion,
            2,
            18,
            Some(4),
            8,
        );
        assert_eq!(result["data"]["outcome"]["listing"]["revision"], "5");
        assert_eq!(t.next_listing_id, 6);
    }
    #[test]
    fn hostile_or_unfunded_listing_changes_preserve_every_reservation_and_high_water() {
        let mut t = funded();
        set(
            &mut t,
            ("player.testnet", 4),
            Item::HealthPotion,
            2,
            18,
            None,
            4,
        );
        for (actor, item, q, price, revision, seq) in [
            ("other.testnet", Item::HealthPotion, 1, 18, Some(1), 1),
            ("player.testnet", Item::HealthPotion, 4, 18, Some(1), 5),
            ("player.testnet", Item::HealthPotion, 1, 0, Some(1), 5),
            ("player.testnet", Item::HealthPotion, 1, 101, Some(1), 5),
            ("player.testnet", Item::HealthPotion, 101, 18, Some(1), 5),
            ("player.testnet", Item::HealthPotion, 1, 18, None, 5),
            ("player.testnet", Item::Crystal, 1, 4, None, 5),
            ("player.testnet", Item::HealthPotion, 1, 19, Some(1), 4),
        ] {
            let before = state(&t);
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                    &mut t,
                    (actor, 4),
                    item,
                    q,
                    price,
                    revision,
                    seq
                )))
                .is_err()
            );
            assert_eq!(state(&t), before);
        }
        let id: AccountId = "player.testnet".parse().unwrap();
        t.players
            .get_mut(&id)
            .unwrap()
            .reservations
            .trade
            .quantities[4] = 1;
        let before = state(&t);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                &mut t,
                ("player.testnet", 4),
                Item::HealthPotion,
                3,
                18,
                Some(1),
                5
            )))
            .is_err()
        );
        assert_eq!(state(&t), before);
        cancel(&mut t, "player.testnet", 5, 1, 5);
        let before = state(&t);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cancel(
                &mut t,
                "player.testnet",
                5,
                2,
                6
            )))
            .is_err()
        );
        assert_eq!(state(&t), before);
    }
    #[test]
    fn merchant_listing_batch_is_one_replayable_command() {
        let mut t = town();
        let updates = vec![
            BatchListingUpdate {
                shop_id: Decimal(1),
                item_id: Item::Crystal,
                quantity: Decimal(7),
                unit_price: Decimal(3),
                expected_listing_revision: Some(Decimal(1)),
            },
            BatchListingUpdate {
                shop_id: Decimal(1),
                item_id: Item::IronTool,
                quantity: Decimal(0),
                unit_price: Decimal(5),
                expected_listing_revision: None,
            },
        ];
        context(
            "rex.testnet",
            json!({"updates": updates, "command": command(1)}),
            400_000_000_000,
        );
        let first = t.batch_set_listings(updates.clone(), command(1));
        assert_eq!(first["data"]["principal"], "merchant:rex");
        assert_eq!(first["data"]["command_sequence"], "1");
        assert_eq!(first["data"]["outcome"]["kind"], "listings_set");
        assert_eq!(
            first["data"]["outcome"]["listings"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            t.commands
                .get(&"merchant:rex".to_string())
                .unwrap()
                .sequence,
            1
        );
        context(
            "rex.testnet",
            json!({"updates": updates, "command": command(1)}),
            400_000_000_000,
        );
        let again = t.batch_set_listings(updates, command(1));
        assert_eq!(again["data"]["replayed"], true);
        assert_eq!(
            again["data"]["payload_sha256"],
            first["data"]["payload_sha256"]
        );
    }
    #[test]
    fn npc_prices_stock_and_authority_share_the_persistent_merchant_lane() {
        let mut t = town();
        for (actor, q, price) in [
            ("other.testnet", 1, 4),
            ("rex.testnet", 13, 4),
            ("rex.testnet", 1, 2),
            ("rex.testnet", 1, 7),
        ] {
            let before = state(&t);
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                    &mut t,
                    (actor, 1),
                    Item::Crystal,
                    q,
                    price,
                    Some(1),
                    1
                )))
                .is_err()
            );
            assert_eq!(state(&t), before);
        }
        set(&mut t, ("rex.testnet", 1), Item::Crystal, 7, 3, Some(1), 1);
        t.paused = true;
        let result = cancel(&mut t, "rex.testnet", 1, 2, 2);
        assert_eq!(result["data"]["principal"], "merchant:rex");
        assert_eq!(
            result["data"]["outcome"]["ledger"]["inventory"]["available"]["crystal"],
            "12"
        );
        assert!(t.commands.get(&"account:rex.testnet".to_owned()).is_none());
        let before = state(&t);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| set(
                &mut t,
                ("rex.testnet", 1),
                Item::Crystal,
                1,
                3,
                Some(3),
                3
            )))
            .is_err()
        );
        assert_eq!(state(&t), before);
    }
    #[test]
    fn crafting_cannot_consume_listed_raw_stock_until_cancellation_releases_it() {
        let mut t = town();
        t.npcs[0].held.quantities[2] = 20;
        let payload = |seq| json!({"shop_id":"1","recipe_id":"health_potion","recipe_version":"1","quantity":"3","expected_shop_revision":"1","command":command(seq)});
        context("rex.testnet", payload(1), 400_000_000_000);
        let before = state(&t);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.start_production(
                Decimal(1),
                RecipeId::HealthPotion,
                Decimal(1),
                Decimal(3),
                Decimal(1),
                command(1)
            )))
            .is_err()
        );
        assert_eq!(state(&t), before);
        cancel(&mut t, "rex.testnet", 1, 1, 1);
        context("rex.testnet", payload(2), 400_000_000_000);
        t.start_production(
            Decimal(1),
            RecipeId::HealthPotion,
            Decimal(1),
            Decimal(3),
            Decimal(1),
            command(2),
        );
        assert_eq!(t.npcs[0].held.quantities[0], 9);
        assert_eq!(t.npcs[0].reservations.output.quantities[4], 3);
        assert_eq!(t.npcs[0].listings[0].as_ref().unwrap().quantity, 0);
    }
}
