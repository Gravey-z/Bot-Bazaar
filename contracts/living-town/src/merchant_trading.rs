// The public NEAR ABI (including its generated wrapper) binds buyer, seller and
// quote terms separately; test calls intentionally mirror that complete request.
#![allow(clippy::too_many_arguments)]

use super::*;
use ownership::{Outcome, args, next};
use purchases::MerchantId;

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct MerchantTrade {
    pub buyer: u8,
    seller: u8,
    id: u64,
    item: Item,
    quantity: u64,
    unit_price: u64,
    listing_id: u64,
    settled_at_ns: u64,
    command_sequence: u64,
    event_sequence: u64,
}
impl MerchantTrade {
    pub(crate) fn view(&self) -> Value {
        json!({"trade_id":self.id.to_string(),"kind":"raw_purchase","buyer":{"kind":"merchant","merchant_id":MERCHANTS[self.buyer as usize]},"seller":{"kind":"merchant","merchant_id":MERCHANTS[self.seller as usize]},"customer_pool_id":null,"item_id":self.item,"quantity":self.quantity.to_string(),"unit_price":self.unit_price.to_string(),"total_price":(self.quantity*self.unit_price).to_string(),"listing_id":self.listing_id.to_string(),"offer_id":null,"consumed_quantity":"0","settled_at_ns":self.settled_at_ns.to_string(),"command_principal":format!("merchant:{}",MERCHANTS[self.buyer as usize]),"command_sequence":self.command_sequence.to_string(),"event_sequence":self.event_sequence.to_string()})
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct MerchantPurchase {
    pub trade: MerchantTrade,
    listing: Listing,
    buyer: Npc,
    seller: Npc,
}
impl MerchantPurchase {
    pub(crate) fn view(&self) -> Value {
        json!({"kind":"raw_purchased","trade":self.trade.view(),"listing":listings::view(self.trade.seller as u64+1,self.trade.item,&self.listing,&production::Owner::Merchant(self.trade.seller)),"buyer":purchases::npc_ledger(self.trade.buyer as usize,&self.buyer),"seller":purchases::npc_ledger(self.trade.seller as usize,&self.seller)})
    }
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BuyArgs {
    buyer_merchant_id: MerchantId,
    merchant_id: MerchantId,
    item_id: Item,
    quantity: Decimal,
    expected_listing_revision: Decimal,
    max_total_price: Decimal,
    command: Command,
}
// Retained for old serialized outcome/trade discriminants and local historical
// fixtures. Negotiated releases do not export this unilateral purchase ABI.
impl LivingTown {
    #[allow(dead_code)]
    pub fn merchant_purchase(
        &mut self,
        buyer_merchant_id: MerchantId,
        merchant_id: MerchantId,
        item_id: Item,
        quantity: Decimal,
        expected_listing_revision: Decimal,
        max_total_price: Decimal,
        command: Command,
    ) -> Value {
        let p: BuyArgs = args(&[
            "buyer_merchant_id",
            "merchant_id",
            "item_id",
            "quantity",
            "expected_listing_revision",
            "max_total_price",
            "command",
        ]);
        require!(
            p.buyer_merchant_id == buyer_merchant_id
                && p.merchant_id == merchant_id
                && p.item_id == item_id
                && p.quantity == quantity
                && p.expected_listing_revision == expected_listing_revision
                && p.max_total_price == max_total_price
                && p.command == command,
            "LT:E_INVALID_ARGUMENT"
        );
        let b = buyer_merchant_id as usize;
        let s = merchant_id as usize;
        let actor = env::predecessor_account_id();
        require!(actor == self.controllers[b], "LT:E_UNAUTHORIZED");
        require!(b != s, "LT:E_SELF_TRADE");
        let (digest,replay)=self.command_check(&actor,"merchant_purchase",json!({"buyer_merchant_id":buyer_merchant_id,"merchant_id":merchant_id,"item_id":item_id,"quantity":quantity,"expected_listing_revision":expected_listing_revision,"max_total_price":max_total_price,"command":command}),&command);
        if let Some(value) = replay {
            return value;
        }
        let slot = item_id as usize;
        require!(
            slot < 4 && (1..=2).contains(&quantity.0) && (1..=10000).contains(&max_total_price.0),
            "LT:E_INVALID_ARGUMENT"
        );
        let mut buyer = self.npcs[b].clone();
        let mut seller = self.npcs[s].clone();
        let mut listing = seller.listings[slot]
            .clone()
            .unwrap_or_else(|| env::panic_str("LT:E_LISTING_NOT_FOUND"));
        require!(
            listing.revision == expected_listing_revision.0,
            "LT:E_STALE_LISTING"
        );
        require!(listing.quantity >= quantity.0, "LT:E_INSUFFICIENT_STOCK");
        require!(
            seller.held.quantities[slot]
                >= listing.quantity + seller.reservations.trade.quantities[slot],
            "LT:E_RESERVED_STOCK"
        );
        let cost = quantity
            .0
            .checked_mul(listing.unit_price)
            .expect("bounded price");
        require!(cost <= max_total_price.0, "LT:E_PRICE_CHANGED");
        let floor = [80, 120, 60][b];
        require!(
            buyer
                .gold
                .checked_sub(buyer.reservations.gold_trade)
                .is_some_and(|n| n >= cost + floor),
            "LT:E_INSUFFICIENT_GOLD"
        );
        let target = if [0, 2, 1, 2][slot] == b {
            [10, 10, 20, 20][slot]
        } else {
            2
        };
        let held = buyer.held.quantities[slot]
            .checked_add(quantity.0)
            .expect("bounded quantity");
        require!(
            held <= target
                && held
                    + buyer.reservations.output.quantities[slot]
                    + buyer.reservations.inbound.quantities[slot]
                    <= 1000,
            "LT:E_BALANCE_CAP"
        );
        let seller_gold = seller.gold.checked_add(cost).expect("bounded gold");
        require!(
            seller_gold + seller.reservations.gold_inbound <= 1_000_000,
            "LT:E_BALANCE_CAP"
        );
        buyer.gold -= cost;
        buyer.held.quantities[slot] = held;
        buyer.ledger_revision = next(buyer.ledger_revision);
        seller.gold = seller_gold;
        seller.held.quantities[slot] -= quantity.0;
        seller.ledger_revision = next(seller.ledger_revision);
        listing.quantity -= quantity.0;
        listing.revision = next(listing.revision);
        seller.listings[slot] = Some(listing.clone());
        let trade = MerchantTrade {
            buyer: b as u8,
            seller: s as u8,
            id: self.next_trade_id,
            item: item_id,
            quantity: quantity.0,
            unit_price: listing.unit_price,
            listing_id: listing.id,
            settled_at_ns: env::block_timestamp(),
            command_sequence: command.sequence.0,
            event_sequence: next(self.market_revision),
        };
        self.next_trade_id = next(trade.id);
        self.trades
            .insert(trade.id, purchases::Trade::Merchant(trade.clone()));
        if trade.id > 256 {
            self.trades.remove(&(trade.id - 256));
        }
        self.npcs[b] = buyer.clone();
        self.npcs[s] = seller.clone();
        self.commit(
            actor,
            command,
            digest,
            Outcome::MerchantPurchased(Box::new(MerchantPurchase {
                trade,
                listing,
                buyer,
                seller,
            })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::production::tests::{context, town};
    fn command(sequence: u64) -> Command {
        Command {
            sequence: Decimal(sequence),
            config_version: Decimal(1),
            valid_until_ns: Decimal(500_000_000_000),
        }
    }
    fn buy(
        t: &mut LivingTown,
        actor: &str,
        buyer: MerchantId,
        seller: MerchantId,
        item: Item,
        quantity: u64,
        revision: u64,
        max: u64,
        sequence: u64,
    ) -> Value {
        let c = command(sequence);
        context(
            actor,
            json!({"buyer_merchant_id":buyer,"merchant_id":seller,"item_id":item,"quantity":quantity.to_string(),"expected_listing_revision":revision.to_string(),"max_total_price":max.to_string(),"command":c}),
            10,
        );
        t.merchant_purchase(
            buyer,
            seller,
            item,
            Decimal(quantity),
            Decimal(revision),
            Decimal(max),
            c,
        )
    }
    #[test]
    fn backup_purchase_resale_and_replay_conserve_existing_gold_and_materials() {
        let mut t = town();
        let revision = t.npcs[0].listings[0].as_ref().unwrap().revision;
        let first = buy(
            &mut t,
            "luna.testnet",
            MerchantId::Luna,
            MerchantId::Rex,
            Item::Crystal,
            2,
            revision,
            8,
            1,
        );
        assert_eq!(first["data"]["principal"], "merchant:luna");
        assert_eq!(t.npcs[0].held.quantities[0], 8);
        assert_eq!(t.npcs[1].held.quantities[0], 2);
        assert_eq!(t.npcs.iter().map(|n| n.gold).sum::<u64>(), 600);
        let before = near_sdk::borsh::to_vec(&t).unwrap();
        let replay = buy(
            &mut t,
            "luna.testnet",
            MerchantId::Luna,
            MerchantId::Rex,
            Item::Crystal,
            2,
            revision,
            8,
            1,
        );
        assert_eq!(replay["data"]["replayed"], true);
        assert_eq!(near_sdk::borsh::to_vec(&t).unwrap(), before);
        let c = command(2);
        context(
            "luna.testnet",
            json!({"shop_id":"2","item_id":"crystal","quantity":"2","unit_price":"5","expected_listing_revision":null,"command":c}),
            11,
        );
        t.set_listing(Decimal(2), Item::Crystal, Decimal(2), Decimal(5), None, c);
        // Controlled rapid player demand: remove six crystals before the emergency buyback.
        t.npcs[0].held.quantities[0] = 2;
        t.npcs[0].listings[0].as_mut().unwrap().quantity = 0;
        let revision = t.npcs[1].listings[0].as_ref().unwrap().revision;
        buy(
            &mut t,
            "rex.testnet",
            MerchantId::Rex,
            MerchantId::Luna,
            Item::Crystal,
            2,
            revision,
            10,
            1,
        );
        assert_eq!(t.npcs[0].held.quantities[0], 4);
        assert_eq!(t.npcs[1].held.quantities[0], 0);
        assert_eq!(t.npcs[1].gold, 202);
        assert_eq!(t.npcs.iter().map(|n| n.gold).sum::<u64>(), 600);
        assert_eq!(t.npcs[1].listings[0].as_ref().unwrap().quantity, 0);
    }
    #[test]
    fn authority_stale_quotes_price_quantity_and_backup_caps_reject_without_mutation() {
        let mut t = town();
        let revision = t.npcs[0].listings[0].as_ref().unwrap().revision;
        for (actor, buyer, seller, q, rev, max) in [
            (
                "intruder.testnet",
                MerchantId::Luna,
                MerchantId::Rex,
                1,
                revision,
                8,
            ),
            (
                "rex.testnet",
                MerchantId::Rex,
                MerchantId::Rex,
                1,
                revision,
                8,
            ),
            (
                "luna.testnet",
                MerchantId::Luna,
                MerchantId::Rex,
                3,
                revision,
                12,
            ),
            (
                "luna.testnet",
                MerchantId::Luna,
                MerchantId::Rex,
                1,
                revision + 1,
                8,
            ),
            (
                "luna.testnet",
                MerchantId::Luna,
                MerchantId::Rex,
                2,
                revision,
                1,
            ),
        ] {
            let before = near_sdk::borsh::to_vec(&t).unwrap();
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(
                    &mut t,
                    actor,
                    buyer,
                    seller,
                    Item::Crystal,
                    q,
                    rev,
                    max,
                    1
                )))
                .is_err()
            );
            assert_eq!(near_sdk::borsh::to_vec(&t).unwrap(), before);
        }
        buy(
            &mut t,
            "luna.testnet",
            MerchantId::Luna,
            MerchantId::Rex,
            Item::Crystal,
            2,
            revision,
            8,
            1,
        );
        let revision = t.npcs[0].listings[0].as_ref().unwrap().revision;
        let before = near_sdk::borsh::to_vec(&t).unwrap();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| buy(
                &mut t,
                "luna.testnet",
                MerchantId::Luna,
                MerchantId::Rex,
                Item::Crystal,
                1,
                revision,
                4,
                2
            )))
            .is_err()
        );
        assert_eq!(near_sdk::borsh::to_vec(&t).unwrap(), before);
    }
}
