use super::*;
use ownership::{Outcome, Player, args, next};

#[near(serializers=[borsh])]
#[derive(Clone)]
pub(crate) struct Pool {
    pub gold: u64,
    pub last_funded: u64,
    pub counts_epoch: u64,
    pub counts: [u64; 2],
    pub revision: u64,
}
impl Pool {
    pub(super) fn initial() -> Self {
        Self {
            gold: 100,
            last_funded: 0,
            counts_epoch: 0,
            counts: [0; 2],
            revision: 1,
        }
    }
    pub(super) fn view(&self, epoch: u64) -> Value {
        let counts = if epoch == self.counts_epoch {
            self.counts
        } else {
            [0; 2]
        };
        json!({"pool_id":"town_customers","gold":self.gold.to_string(),"epoch":epoch.to_string(),"last_funded_epoch":self.last_funded.to_string(),"potion_units_bought":counts[0].to_string(),"tool_units_bought":counts[1].to_string(),"revision":self.revision.to_string()})
    }
}
#[near(serializers=[borsh])]
#[derive(Clone)]
pub(crate) struct SaleTrade {
    pub id: u64,
    seller: AccountId,
    item: Item,
    price: u64,
    listing_id: u64,
    time: u64,
    operator: AccountId,
    sequence: u64,
    event: u64,
}
impl SaleTrade {
    pub(super) fn view(&self) -> Value {
        json!({"trade_id":self.id.to_string(),"kind":"customer_sale","buyer":null,"customer_pool_id":"town_customers","seller":{"kind":"player","account_id":self.seller},"item_id":self.item,"quantity":"1","unit_price":self.price.to_string(),"total_price":self.price.to_string(),"listing_id":self.listing_id.to_string(),"offer_id":null,"consumed_quantity":"1","settled_at_ns":self.time.to_string(),"command_principal":format!("account:{}",self.operator),"command_sequence":self.sequence.to_string(),"event_sequence":self.event.to_string()})
    }
}
#[near(serializers=[borsh])]
#[derive(Clone)]
pub(crate) struct Funded {
    epoch: u64,
    issued: u64,
    pool: Pool,
}
impl Funded {
    pub(super) fn view(&self) -> Value {
        json!({"kind":"customer_funded","epoch":self.epoch.to_string(),"issued_gold":self.issued.to_string(),"pool":self.pool.view(self.epoch)})
    }
}
#[near(serializers=[borsh])]
#[derive(Clone)]
pub(crate) struct Sale {
    trade: SaleTrade,
    listing: Listing,
    seller: Player,
    pool: Pool,
    epoch: u64,
    shop: u64,
}
impl Sale {
    pub(super) fn view(&self) -> Value {
        json!({"kind":"customer_sale","trade":self.trade.view(),"listing":listings::view(self.shop,self.trade.item,&self.listing,&production::Owner::Player(self.seller.account_id.clone())),"seller":self.seller.ledger(),"pool":self.pool.view(self.epoch)})
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct FundArgs {
    epoch: Decimal,
    command: Command,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct SaleArgs {
    listing_id: Decimal,
    expected_listing_revision: Decimal,
    epoch: Decimal,
    max_total_price: Decimal,
    command: Command,
}
impl LivingTown {
    pub(super) fn customer_epoch(&self) -> u64 {
        (env::block_timestamp() - self.genesis_time_ns) / 60_000_000_000
    }
    fn customer_operator(&self) -> AccountId {
        let actor = env::predecessor_account_id();
        require!(actor == self.operator, "LT:E_UNAUTHORIZED");
        actor
    }
}
#[near]
impl LivingTown {
    pub fn fund_customer_budget(&mut self, epoch: Decimal, command: Command) -> Value {
        let p: FundArgs = args(&["epoch", "command"]);
        require!(
            p.epoch == epoch && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = self.customer_operator();
        let (digest, replay) = self.command_check(
            &actor,
            "fund_customer_budget",
            json!({"epoch":epoch,"command":command}),
            &command,
        );
        if let Some(result) = replay {
            return result;
        }
        require!(epoch.0 == self.customer_epoch(), "LT:E_EPOCH_MISMATCH");
        require!(
            epoch.0 > self.customer_pool.last_funded,
            "LT:E_EPOCH_ALLOCATED"
        );
        let mut pool = self.customer_pool.clone();
        let issued = 200u64
            .checked_sub(pool.gold)
            .unwrap_or_else(|| env::panic_str("LT:E_CUSTOMER_BUDGET"))
            .min(100);
        pool.gold += issued;
        pool.last_funded = epoch.0;
        pool.revision = next(pool.revision);
        let total = self
            .customer_topups
            .checked_add(u128::from(issued))
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        self.customer_pool = pool.clone();
        self.customer_topups = total;
        self.commit(
            actor,
            command,
            digest,
            Outcome::CustomerFunded(Box::new(Funded {
                epoch: epoch.0,
                issued,
                pool,
            })),
        )
    }
    pub fn settle_customer_purchase(
        &mut self,
        listing_id: Decimal,
        expected_listing_revision: Decimal,
        epoch: Decimal,
        max_total_price: Decimal,
        command: Command,
    ) -> Value {
        let p: SaleArgs = args(&[
            "listing_id",
            "expected_listing_revision",
            "epoch",
            "max_total_price",
            "command",
        ]);
        require!(
            p.listing_id == listing_id
                && p.expected_listing_revision == expected_listing_revision
                && p.epoch == epoch
                && p.max_total_price == max_total_price
                && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let actor = self.customer_operator();
        let (digest,replay)=self.command_check(&actor,"settle_customer_purchase",json!({"listing_id":listing_id,"expected_listing_revision":expected_listing_revision,"epoch":epoch,"max_total_price":max_total_price,"command":command}),&command);
        if let Some(result) = replay {
            return result;
        }
        require!(epoch.0 == self.customer_epoch(), "LT:E_EPOCH_MISMATCH");
        require!((1..=10000).contains(&max_total_price.0), "LT:E_MAX_TOTAL");
        let (shop, item, mut listing) = self
            .listing_row(listing_id.0)
            .unwrap_or_else(|| env::panic_str("LT:E_LISTING_NOT_FOUND"));
        require!(
            shop > 3 && matches!(item, Item::HealthPotion | Item::IronTool),
            "LT:E_CUSTOMER_SELLER"
        );
        require!(
            listing.revision == expected_listing_revision.0,
            "LT:E_STALE_LISTING"
        );
        require!(listing.quantity > 0, "LT:E_LISTING_INACTIVE");
        let slot = item as usize;
        let product = slot - 4;
        let wtp = config()["economy"]["recipes"][ITEM_IDS[slot]]["salePrice"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        require!(listing.unit_price <= wtp, "LT:E_NO_DEMAND");
        require!(listing.unit_price <= max_total_price.0, "LT:E_MAX_TOTAL");
        let mut pool = self.customer_pool.clone();
        if pool.counts_epoch != epoch.0 {
            pool.counts_epoch = epoch.0;
            pool.counts = [0; 2];
        }
        require!(pool.counts[product] < 2, "LT:E_CUSTOMER_QUOTA");
        require!(pool.gold >= listing.unit_price, "LT:E_CUSTOMER_BUDGET");
        let owner = self.shops.get(&shop).expect("shop").owner.clone();
        let mut seller = self.players.get(&owner).expect("player").clone();
        require!(
            seller.reservations.listing.quantities[slot] == listing.quantity
                && seller.inventory.quantities[slot]
                    .checked_sub(seller.reservations.trade.quantities[slot])
                    .is_some_and(|held| held >= listing.quantity),
            "LT:E_INSUFFICIENT_AVAILABLE_STOCK"
        );
        let gold = seller
            .gold
            .checked_add(listing.unit_price)
            .filter(|gold| {
                gold.checked_add(seller.reservations.gold_inbound)
                    .is_some_and(|held| held <= 1_000_000)
            })
            .unwrap_or_else(|| env::panic_str("LT:E_BALANCE_CAP"));
        let seller_revision = next(seller.ledger_revision);
        let listing_revision = next(listing.revision);
        let pool_revision = next(pool.revision);
        let consumed = self.customer_consumed[slot]
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        let id = self.next_trade_id;
        let next_id = next(id);
        let event = next(self.market_revision);
        seller.gold = gold;
        seller.ledger_revision = seller_revision;
        seller.inventory.quantities[slot] -= 1;
        seller.reservations.listing.quantities[slot] -= 1;
        pool.gold -= listing.unit_price;
        pool.counts[product] += 1;
        pool.revision = pool_revision;
        listing.quantity -= 1;
        listing.revision = listing_revision;
        let trade = SaleTrade {
            id,
            seller: owner.clone(),
            item,
            price: listing.unit_price,
            listing_id: listing.id,
            time: env::block_timestamp(),
            operator: actor.clone(),
            sequence: command.sequence.0,
            event,
        };
        self.players.insert(owner, seller.clone());
        self.player_listings.insert(listing.id, listing.clone());
        self.customer_pool = pool.clone();
        self.customer_consumed[slot] = consumed;
        self.next_trade_id = next_id;
        self.trades
            .insert(id, purchases::Trade::Customer(trade.clone()));
        if id > 256 {
            self.trades.remove(&(id - 256));
        }
        self.commit(
            actor,
            command,
            digest,
            Outcome::CustomerSale(Box::new(Sale {
                trade,
                listing,
                seller,
                pool,
                epoch: epoch.0,
                shop,
            })),
        )
    }
}

#[cfg(test)]
#[path = "customer_tests.rs"]
mod tests;
