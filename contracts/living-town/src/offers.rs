// MT-001 deliberately exposes each immutable economic term in the public ABI.
#![allow(clippy::too_many_arguments)]
use super::*;
use near_sdk::serde::Serialize;
use ownership::{Decimal, Outcome, args, next};

const PRIMARY: [usize; 4] = [0, 2, 1, 2];
const FLOOR: [u64; 4] = [2, 2, 4, 4];
const TARGET: [u64; 4] = [20; 4];
const MIN_PRICE: [u64; 4] = [3, 1, 2, 3];
const MAX_PRICE: [u64; 4] = [6, 3, 4, 6];
const GOLD_FLOOR: [u64; 3] = [80, 120, 60];

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Pending,
    Accepted,
    Rejected,
    Cancelled,
    Expired,
}
impl Status {
    fn name(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        }
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Offer {
    id: u64,
    buyer: u8,
    seller: u8,
    item: Item,
    quantity: u64,
    unit_price: u64,
    created_at: u64,
    expires_at: u64,
    status: Status,
    revision: u64,
    trade_id: Option<u64>,
    proposal_sequence: u64,
    closed_at: Option<u64>,
    closing_merchant: Option<u8>,
    closing_sequence: Option<u64>,
}
impl Offer {
    fn total(&self) -> u64 {
        self.quantity
            .checked_mul(self.unit_price)
            .expect("bounded terms")
    }
    pub(crate) fn view(&self, at: u64) -> Value {
        json!({"offer_id":self.id.to_string(),"proposer":MERCHANTS[self.buyer as usize],"buyer":MERCHANTS[self.buyer as usize],"seller":MERCHANTS[self.seller as usize],"item_id":self.item,"quantity":self.quantity.to_string(),"unit_price":self.unit_price.to_string(),"total_price":self.total().to_string(),"created_at_ns":self.created_at.to_string(),"expires_at_ns":self.expires_at.to_string(),"status":self.status.name(),"expired":self.status==Status::Expired||(self.status==Status::Pending&&at>=self.expires_at),"revision":self.revision.to_string(),"trade_id":self.trade_id.map(|v|v.to_string()),"proposal_command_sequence":self.proposal_sequence.to_string(),"closed_at_ns":self.closed_at.map(|v|v.to_string()),"closing_principal":self.closing_merchant.map(|m|format!("merchant:{}",MERCHANTS[m as usize])),"closing_command_sequence":self.closing_sequence.map(|v|v.to_string())})
    }
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct NegotiatedTrade {
    pub offer: Offer,
    pub id: u64,
    pub event_sequence: u64,
}
impl NegotiatedTrade {
    pub(crate) fn view(&self) -> Value {
        let o = &self.offer;
        json!({"trade_id":self.id.to_string(),"kind":"merchant_trade","buyer":{"kind":"merchant","merchant_id":MERCHANTS[o.buyer as usize]},"seller":{"kind":"merchant","merchant_id":MERCHANTS[o.seller as usize]},"customer_pool_id":null,"item_id":o.item,"quantity":o.quantity.to_string(),"unit_price":o.unit_price.to_string(),"total_price":o.total().to_string(),"listing_id":null,"offer_id":o.id.to_string(),"consumed_quantity":"0","settled_at_ns":o.closed_at.expect("accepted").to_string(),"command_principal":format!("merchant:{}",MERCHANTS[o.seller as usize]),"command_sequence":o.closing_sequence.expect("accepted").to_string(),"event_sequence":self.event_sequence.to_string()})
    }
}
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Proposed,
    Accepted,
    Rejected,
    Cancelled,
    Expired,
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct Effect {
    pub actor: u8,
    pub kind: Kind,
    pub offers: Vec<Offer>,
    pub ledgers: Vec<(u8, Npc)>,
    pub trade: Option<NegotiatedTrade>,
    pub skipped: Vec<u64>,
    pub at: u64,
}
impl Effect {
    pub(crate) fn method(&self) -> &'static str {
        match self.kind {
            Kind::Proposed => "propose_trade",
            Kind::Accepted => "accept_trade",
            Kind::Rejected => "reject_trade",
            Kind::Cancelled => "cancel_trade",
            Kind::Expired => "expire_offers",
        }
    }
    pub(crate) fn releasing(&self) -> bool {
        matches!(self.kind, Kind::Rejected | Kind::Cancelled | Kind::Expired)
    }
    pub(crate) fn view(&self) -> Value {
        let ledger = |m: u8| {
            let (_, npc) = self
                .ledgers
                .iter()
                .find(|(id, _)| *id == m)
                .expect("effect ledger");
            purchases::npc_ledger(m as usize, npc)
        };
        if matches!(self.kind, Kind::Expired) {
            return json!({"kind":"offers_expired","offers":self.offers.iter().map(|o|o.view(self.at)).collect::<Vec<_>>(),"skipped_offer_ids":self.skipped.iter().map(u64::to_string).collect::<Vec<_>>(),"ledgers":self.ledgers.iter().map(|(id,n)|purchases::npc_ledger(*id as usize,n)).collect::<Vec<_>>()});
        }
        let o = &self.offers[0];
        match self.kind {
            Kind::Proposed => {
                json!({"kind":"trade_proposed","offer":o.view(self.at),"buyer":ledger(o.buyer)})
            }
            Kind::Accepted => {
                json!({"kind":"trade_accepted","offer":o.view(self.at),"trade":self.trade.as_ref().expect("accepted trade").view(),"buyer":ledger(o.buyer),"seller":ledger(o.seller)})
            }
            Kind::Rejected | Kind::Cancelled => {
                json!({"kind":if matches!(self.kind,Kind::Rejected){"trade_rejected"}else{"trade_cancelled"},"offer":o.view(self.at),"buyer":ledger(o.buyer)})
            }
            Kind::Expired => unreachable!(),
        }
    }
}

fn checked<T: DeserializeOwned + Serialize>(normalized: &Value) -> T {
    let keys: Vec<_> = normalized
        .as_object()
        .expect("arguments")
        .keys()
        .map(String::as_str)
        .collect();
    let p: T = args(&keys);
    require!(
        serde_json::to_value(&p).expect("arguments") == *normalized,
        "LT:E_INVALID_ARGUMENT"
    );
    p
}
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ProposeArgs {
    buyer_merchant_id: MerchantId,
    seller_merchant_id: MerchantId,
    item_id: Item,
    quantity: Decimal,
    unit_price: Decimal,
    expires_at_ns: Decimal,
    expected_buyer_ledger_revision: Decimal,
    expected_seller_ledger_revision: Decimal,
    command: Command,
}
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct AcceptArgs {
    merchant_id: MerchantId,
    offer_id: Decimal,
    expected_offer_revision: Decimal,
    expected_buyer_ledger_revision: Decimal,
    expected_seller_ledger_revision: Decimal,
    command: Command,
}
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct CloseArgs {
    merchant_id: MerchantId,
    offer_id: Decimal,
    expected_offer_revision: Decimal,
    command: Command,
}
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct ExpireArgs {
    merchant_id: MerchantId,
    offer_ids: Vec<Decimal>,
    command: Command,
}
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct OfferArgs {
    offer_id: Decimal,
}
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PageArgs {
    merchant_id: Option<MerchantId>,
    status: String,
    after_id: Option<Decimal>,
    limit: Decimal,
    expected_market_revision: Decimal,
}

fn add(a: u64, b: u64) -> u64 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"))
}
fn sub(a: u64, b: u64) -> u64 {
    a.checked_sub(b)
        .unwrap_or_else(|| env::panic_str("LT:E_INVALID_RESERVATION"))
}
fn authorize(t: &LivingTown, m: usize) {
    require!(
        env::predecessor_account_id() == t.controllers[m],
        "LT:E_UNAUTHORIZED"
    );
}
fn capacity(n: &Npc, slot: usize, extra: u64, merchant: usize) {
    let promised = add(
        add(
            n.held.quantities[slot],
            n.reservations.inbound.quantities[slot],
        ),
        extra,
    );
    require!(
        add(promised, n.reservations.output.quantities[slot]) <= 1000,
        "LT:E_BALANCE_CAP"
    );
    require!(
        promised
            <= if PRIMARY[slot] == merchant {
                TARGET[slot]
            } else {
                7
            },
        "LT:E_TRADE_TARGET_CAP"
    );
}
impl LivingTown {
    fn pending_offer(&self, id: u64, revision: u64) -> Offer {
        require!(id > 0, "LT:E_INVALID_INTEGER");
        let o = self
            .offers
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("LT:E_OFFER_NOT_FOUND"));
        require!(o.revision == revision, "LT:E_STALE_OFFER");
        require!(o.status == Status::Pending, "LT:E_OFFER_NOT_PENDING");
        o
    }
    fn finish_offer(
        &mut self,
        mut o: Offer,
        status: Status,
        actor: u8,
        seq: u64,
        trade: Option<u64>,
    ) -> Offer {
        o.status = status;
        o.revision = next(o.revision);
        o.closed_at = Some(env::block_timestamp());
        o.closing_merchant = Some(actor);
        o.closing_sequence = Some(seq);
        o.trade_id = trade;
        self.pending_offers.retain(|id| *id != o.id);
        for m in [o.buyer, o.seller] {
            self.pending_offer_counts[m as usize] = self.pending_offer_counts[m as usize]
                .checked_sub(1)
                .expect("pending count");
        }
        self.offers.insert(o.id, o.clone());
        self.closed_offers.push_back(o.id);
        if self.closed_offers.len() > 128 {
            let id = self.closed_offers.pop_front().expect("closed");
            self.offers.remove(&id);
            self.pruned_offer_through = self.pruned_offer_through.max(id);
        }
        o
    }
    fn close_offer(
        &mut self,
        merchant_id: MerchantId,
        offer_id: Decimal,
        expected_offer_revision: Decimal,
        command: Command,
        kind: Kind,
    ) -> Value {
        let normalized = json!({"merchant_id":merchant_id,"offer_id":offer_id,"expected_offer_revision":expected_offer_revision,"command":command});
        let _: CloseArgs = checked(&normalized);
        let m = merchant_id as usize;
        authorize(self, m);
        let method = if matches!(kind, Kind::Rejected) {
            "reject_trade"
        } else {
            "cancel_trade"
        };
        let actor = env::predecessor_account_id();
        let (digest, replay) = self.command_check(&actor, method, normalized, &command);
        if let Some(v) = replay {
            return v;
        }
        let o = self.pending_offer(offer_id.0, expected_offer_revision.0);
        require!(
            m == if matches!(kind, Kind::Rejected) {
                o.seller as usize
            } else {
                o.buyer as usize
            },
            "LT:E_UNAUTHORIZED"
        );
        require!(env::block_timestamp() < o.expires_at, "LT:E_OFFER_EXPIRED");
        let mut buyer = self.npcs[o.buyer as usize].clone();
        let slot = o.item as usize;
        buyer.reservations.gold_trade = sub(buyer.reservations.gold_trade, o.total());
        buyer.reservations.inbound.quantities[slot] =
            sub(buyer.reservations.inbound.quantities[slot], o.quantity);
        buyer.ledger_revision = next(buyer.ledger_revision);
        let o = self.finish_offer(
            o,
            if matches!(kind, Kind::Rejected) {
                Status::Rejected
            } else {
                Status::Cancelled
            },
            m as u8,
            command.sequence.0,
            None,
        );
        self.npcs[o.buyer as usize] = buyer.clone();
        self.commit(
            actor,
            command,
            digest,
            Outcome::MerchantOffer(Box::new(Effect {
                actor: m as u8,
                kind,
                ledgers: vec![(o.buyer, buyer)],
                offers: vec![o],
                trade: None,
                skipped: vec![],
                at: env::block_timestamp(),
            })),
        )
    }
}

#[near]
impl LivingTown {
    pub fn propose_trade(
        &mut self,
        buyer_merchant_id: MerchantId,
        seller_merchant_id: MerchantId,
        item_id: Item,
        quantity: Decimal,
        unit_price: Decimal,
        expires_at_ns: Decimal,
        expected_buyer_ledger_revision: Decimal,
        expected_seller_ledger_revision: Decimal,
        command: Command,
    ) -> Value {
        let normalized = json!({"buyer_merchant_id":buyer_merchant_id,"seller_merchant_id":seller_merchant_id,"item_id":item_id,"quantity":quantity,"unit_price":unit_price,"expires_at_ns":expires_at_ns,"expected_buyer_ledger_revision":expected_buyer_ledger_revision,"expected_seller_ledger_revision":expected_seller_ledger_revision,"command":command});
        let _: ProposeArgs = checked(&normalized);
        let b = buyer_merchant_id as usize;
        let s = seller_merchant_id as usize;
        authorize(self, b);
        require!(b != s, "LT:E_SELF_TRADE");
        let actor = env::predecessor_account_id();
        let (digest, replay) = self.command_check(&actor, "propose_trade", normalized, &command);
        if let Some(v) = replay {
            return v;
        }
        let slot = item_id as usize;
        require!(
            slot < 4 && (1..=4).contains(&quantity.0),
            "LT:E_INVALID_QUANTITY"
        );
        require!(b != s, "LT:E_SELF_TRADE");
        require!(
            (MIN_PRICE[slot]..=MAX_PRICE[slot]).contains(&unit_price.0),
            "LT:E_PRICE_BAND"
        );
        let now = env::block_timestamp();
        require!(
            expires_at_ns.0 >= add(now, 60_000_000_000)
                && expires_at_ns.0 <= add(now, 600_000_000_000),
            "LT:E_INVALID_OFFER_EXPIRY"
        );
        require!(
            self.pending_offers.len() < 12
                && self.pending_offer_counts[b] < 8
                && self.pending_offer_counts[s] < 8,
            "LT:E_OFFER_CAPACITY"
        );
        let mut buyer = self.npcs[b].clone();
        let seller = &self.npcs[s];
        require!(
            buyer.ledger_revision == expected_buyer_ledger_revision.0
                && seller.ledger_revision == expected_seller_ledger_revision.0,
            "LT:E_STALE_LEDGER"
        );
        let cost = quantity
            .0
            .checked_mul(unit_price.0)
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        require!(
            buyer
                .gold
                .checked_sub(buyer.reservations.gold_trade)
                .and_then(|g| g.checked_sub(cost))
                .is_some_and(|g| g >= GOLD_FLOOR[b]),
            "LT:E_INSUFFICIENT_GOLD"
        );
        capacity(&buyer, slot, quantity.0, b);
        let floor = if s == PRIMARY[slot] { FLOOR[slot] } else { 2 };
        require!(
            seller.held.quantities[slot]
                .checked_sub(seller.reservations.trade.quantities[slot])
                .and_then(|h| h.checked_sub(quantity.0))
                .is_some_and(|h| h >= floor),
            "LT:E_INSUFFICIENT_AVAILABLE_STOCK"
        );
        require!(
            add(add(seller.gold, seller.reservations.gold_inbound), cost) <= 1_000_000,
            "LT:E_BALANCE_CAP"
        );
        let id = self.next_offer_id;
        let next_id = next(id);
        buyer.reservations.gold_trade = add(buyer.reservations.gold_trade, cost);
        buyer.reservations.inbound.quantities[slot] =
            add(buyer.reservations.inbound.quantities[slot], quantity.0);
        buyer.ledger_revision = next(buyer.ledger_revision);
        let o = Offer {
            id,
            buyer: b as u8,
            seller: s as u8,
            item: item_id,
            quantity: quantity.0,
            unit_price: unit_price.0,
            created_at: now,
            expires_at: expires_at_ns.0,
            status: Status::Pending,
            revision: 1,
            trade_id: None,
            proposal_sequence: command.sequence.0,
            closed_at: None,
            closing_merchant: None,
            closing_sequence: None,
        };
        self.next_offer_id = next_id;
        self.pending_offers.push(id);
        self.pending_offer_counts[b] += 1;
        self.pending_offer_counts[s] += 1;
        self.offers.insert(id, o.clone());
        self.npcs[b] = buyer.clone();
        self.commit(
            actor,
            command,
            digest,
            Outcome::MerchantOffer(Box::new(Effect {
                actor: b as u8,
                kind: Kind::Proposed,
                offers: vec![o],
                ledgers: vec![(b as u8, buyer)],
                trade: None,
                skipped: vec![],
                at: now,
            })),
        )
    }
    pub fn accept_trade(
        &mut self,
        merchant_id: MerchantId,
        offer_id: Decimal,
        expected_offer_revision: Decimal,
        expected_buyer_ledger_revision: Decimal,
        expected_seller_ledger_revision: Decimal,
        command: Command,
    ) -> Value {
        let normalized = json!({"merchant_id":merchant_id,"offer_id":offer_id,"expected_offer_revision":expected_offer_revision,"expected_buyer_ledger_revision":expected_buyer_ledger_revision,"expected_seller_ledger_revision":expected_seller_ledger_revision,"command":command});
        let _: AcceptArgs = checked(&normalized);
        let s = merchant_id as usize;
        authorize(self, s);
        let actor = env::predecessor_account_id();
        let (digest, replay) = self.command_check(&actor, "accept_trade", normalized, &command);
        if let Some(v) = replay {
            return v;
        }
        let o = self.pending_offer(offer_id.0, expected_offer_revision.0);
        require!(s == o.seller as usize, "LT:E_UNAUTHORIZED");
        require!(env::block_timestamp() < o.expires_at, "LT:E_OFFER_EXPIRED");
        let b = o.buyer as usize;
        let slot = o.item as usize;
        let cost = o.total();
        let mut buyer = self.npcs[b].clone();
        let mut seller = self.npcs[s].clone();
        require!(
            buyer.ledger_revision == expected_buyer_ledger_revision.0
                && seller.ledger_revision == expected_seller_ledger_revision.0,
            "LT:E_STALE_LEDGER"
        );
        require!(
            buyer.reservations.gold_trade >= cost
                && buyer.reservations.inbound.quantities[slot] >= o.quantity,
            "LT:E_INVALID_RESERVATION"
        );
        require!(
            buyer
                .gold
                .checked_sub(buyer.reservations.gold_trade)
                .is_some_and(|g| g >= GOLD_FLOOR[b]),
            "LT:E_INSUFFICIENT_GOLD"
        );
        capacity(&buyer, slot, 0, b);
        let listed = seller.listings[slot].as_ref().map_or(0, |l| l.quantity);
        let floor = if s == PRIMARY[slot] { FLOOR[slot] } else { 2 };
        require!(
            seller.held.quantities[slot]
                .checked_sub(listed)
                .and_then(|h| h.checked_sub(seller.reservations.trade.quantities[slot]))
                .is_some_and(|h| h >= add(o.quantity, floor)),
            "LT:E_INSUFFICIENT_AVAILABLE_STOCK"
        );
        require!(
            add(add(seller.gold, seller.reservations.gold_inbound), cost) <= 1_000_000,
            "LT:E_BALANCE_CAP"
        );
        buyer.gold = sub(buyer.gold, cost);
        buyer.reservations.gold_trade = sub(buyer.reservations.gold_trade, cost);
        buyer.held.quantities[slot] = add(buyer.held.quantities[slot], o.quantity);
        buyer.reservations.inbound.quantities[slot] =
            sub(buyer.reservations.inbound.quantities[slot], o.quantity);
        buyer.ledger_revision = next(buyer.ledger_revision);
        seller.gold = add(seller.gold, cost);
        seller.held.quantities[slot] = sub(seller.held.quantities[slot], o.quantity);
        seller.ledger_revision = next(seller.ledger_revision);
        capacity(&buyer, slot, 0, b);
        let id = self.next_trade_id;
        let next_trade = next(id);
        let event_sequence = next(self.market_revision);
        let o = self.finish_offer(o, Status::Accepted, s as u8, command.sequence.0, Some(id));
        let trade = NegotiatedTrade {
            offer: o.clone(),
            id,
            event_sequence,
        };
        self.trades
            .insert(id, purchases::Trade::Negotiated(trade.clone()));
        if id > 256 {
            self.trades.remove(&(id - 256));
        }
        self.next_trade_id = next_trade;
        self.npcs[b] = buyer.clone();
        self.npcs[s] = seller.clone();
        self.commit(
            actor,
            command,
            digest,
            Outcome::MerchantOffer(Box::new(Effect {
                actor: s as u8,
                kind: Kind::Accepted,
                offers: vec![o],
                ledgers: vec![(b as u8, buyer), (s as u8, seller)],
                trade: Some(trade),
                skipped: vec![],
                at: env::block_timestamp(),
            })),
        )
    }
    pub fn reject_trade(
        &mut self,
        merchant_id: MerchantId,
        offer_id: Decimal,
        expected_offer_revision: Decimal,
        command: Command,
    ) -> Value {
        self.close_offer(
            merchant_id,
            offer_id,
            expected_offer_revision,
            command,
            Kind::Rejected,
        )
    }
    pub fn cancel_trade(
        &mut self,
        merchant_id: MerchantId,
        offer_id: Decimal,
        expected_offer_revision: Decimal,
        command: Command,
    ) -> Value {
        self.close_offer(
            merchant_id,
            offer_id,
            expected_offer_revision,
            command,
            Kind::Cancelled,
        )
    }
    pub fn expire_offers(
        &mut self,
        merchant_id: MerchantId,
        offer_ids: Vec<Decimal>,
        command: Command,
    ) -> Value {
        let normalized = json!({"merchant_id":merchant_id,"offer_ids":offer_ids,"command":command});
        let _: ExpireArgs = checked(&normalized);
        let m = merchant_id as usize;
        authorize(self, m);
        let actor = env::predecessor_account_id();
        let (digest, replay) = self.command_check(&actor, "expire_offers", normalized, &command);
        if let Some(v) = replay {
            return v;
        }
        require!((1..=24).contains(&offer_ids.len()), "LT:E_INVALID_ARGUMENT");
        let mut ids: Vec<_> = offer_ids.iter().map(|v| v.0).collect();
        ids.sort_unstable();
        require!(
            ids.windows(2).all(|w| w[0] != w[1]),
            "LT:E_INVALID_ARGUMENT"
        );
        let mut staged = self.npcs.clone();
        let mut closing = vec![];
        let mut skipped = vec![];
        let mut affected = [false; 3];
        for id in ids {
            require!(id > 0 && id < self.next_offer_id, "LT:E_OFFER_NOT_FOUND");
            if let Some(o) = self.offers.get(&id) {
                require!(
                    o.buyer as usize == m || o.seller as usize == m,
                    "LT:E_UNAUTHORIZED"
                );
                if o.status == Status::Pending {
                    require!(
                        env::block_timestamp() >= o.expires_at,
                        "LT:E_OFFER_NOT_EXPIRED"
                    );
                    let b = o.buyer as usize;
                    let npc = &mut staged[b];
                    npc.reservations.gold_trade = sub(npc.reservations.gold_trade, o.total());
                    npc.reservations.inbound.quantities[o.item as usize] = sub(
                        npc.reservations.inbound.quantities[o.item as usize],
                        o.quantity,
                    );
                    affected[b] = true;
                    closing.push(o.clone());
                } else {
                    skipped.push(id);
                }
            } else {
                skipped.push(id);
            }
        }
        let mut ledgers = vec![];
        for (i, changed) in affected.iter().enumerate() {
            if *changed {
                staged[i].ledger_revision = next(staged[i].ledger_revision);
                ledgers.push((i as u8, staged[i].clone()));
            }
        }
        let offers = closing
            .into_iter()
            .map(|o| self.finish_offer(o, Status::Expired, m as u8, command.sequence.0, None))
            .collect();
        self.npcs = staged;
        self.commit(
            actor,
            command,
            digest,
            Outcome::MerchantOffer(Box::new(Effect {
                actor: m as u8,
                kind: Kind::Expired,
                offers,
                ledgers,
                trade: None,
                skipped,
                at: env::block_timestamp(),
            })),
        )
    }
    pub fn get_offer(&self, offer_id: Decimal) -> Value {
        let _: OfferArgs = checked(&json!({"offer_id":offer_id}));
        self.assert_versions();
        require!(offer_id.0 > 0, "LT:E_INVALID_INTEGER");
        self.snapshot(if let Some(o)=self.offers.get(&offer_id.0){json!({"kind":"found","offer":o.view(env::block_timestamp())})}else{json!({"kind":if offer_id.0<self.next_offer_id{"pruned"}else{"not_found"},"offer_id":offer_id.0.to_string()})})
    }
    pub fn get_offers(
        &self,
        merchant_id: Option<MerchantId>,
        status: String,
        after_id: Option<Decimal>,
        limit: Decimal,
        expected_market_revision: Decimal,
    ) -> Value {
        let _: PageArgs = checked(
            &json!({"merchant_id":merchant_id,"status":status,"after_id":after_id,"limit":limit,"expected_market_revision":expected_market_revision}),
        );
        self.assert_versions();
        require!(
            (1..=50).contains(&limit.0)
                && matches!(status.as_str(), "pending" | "terminal" | "all")
                && after_id.is_none_or(|a| a.0 > 0),
            "LT:E_INVALID_ARGUMENT"
        );
        require!(
            self.market_revision == expected_market_revision.0,
            "LT:E_STALE_MARKET"
        );
        let mut ids = self.pending_offers.clone();
        ids.extend(self.closed_offers.iter().copied());
        ids.sort_unstable();
        let matching: Vec<_> = ids
            .into_iter()
            .filter(|id| after_id.is_none_or(|a| *id > a.0))
            .filter_map(|id| self.offers.get(&id))
            .filter(|o| merchant_id.is_none_or(|m| o.buyer == m as u8 || o.seller == m as u8))
            .filter(|o| status == "all" || (status == "pending") == (o.status == Status::Pending))
            .collect();
        let page: Vec<_> = matching
            .iter()
            .take(limit.0 as usize)
            .map(|o| o.view(env::block_timestamp()))
            .collect();
        let cursor = page.last().and_then(|v| v["offer_id"].as_str());
        self.snapshot(json!({"items":page,"next_after_id":cursor,"has_more":matching.len()>limit.0 as usize,"history_gap":self.pruned_offer_through>after_id.map_or(0,|a|a.0),"pruned_through":self.pruned_offer_through.to_string()}))
    }
    pub fn get_merchant_trading_rules(&self) -> Value {
        let _: EmptyArgs = input();
        self.assert_versions();
        let cfg = config();
        let mut materials = serde_json::Map::new();
        for (i, item) in ITEM_IDS[..4].iter().enumerate() {
            materials.insert((*item).to_owned(),json!({"supplier":MERCHANTS[PRIMARY[i]],"floor":cfg["economy"]["materials"][*item]["floor"],"target":cfg["economy"]["materials"][*item]["target"],"base_price":cfg["economy"]["materials"][*item]["price"],"min_price":MIN_PRICE[i].to_string(),"max_price":MAX_PRICE[i].to_string()}));
        }
        self.snapshot(json!({"schema":"merchant-offers-v1","items":&ITEM_IDS[..4],"quantity_cap":"4","backup_cap":"7","operating_gold":{"rex":"80","luna":"120","bolt":"60"},"max_pending_global":"12","max_pending_per_merchant":"8","terminal_retention":"128","min_offer_lifetime_seconds":"60","max_offer_lifetime_seconds":"600","materials":materials}))
    }
}

#[cfg(test)]
mod tests;
