use super::{
    Actor, MAX_QUANTITY, MAX_UNIT_PRICE, MerchantId, Resource, StateError, checked_increment,
};

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Listing {
    pub unit_price: u64,
    pub quantity: u64,
    pub active: bool,
    pub version: u64,
}

impl Listing {
    pub fn new(unit_price: u64, quantity: u64, active: bool) -> Result<Self, StateError> {
        if !(1..=MAX_UNIT_PRICE).contains(&unit_price)
            || quantity > MAX_QUANTITY
            || active != (quantity > 0)
        {
            return Err(StateError::InvalidListing);
        }
        Ok(Self {
            unit_price,
            quantity,
            active,
            version: 1,
        })
    }
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MerchantMethod {
    SetListing,
    ProposeTrade,
    AcceptTrade,
    CancelTrade,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastAction {
    pub action_id: u64,
    pub method: MerchantMethod,
    pub args_sha256: [u8; 32],
    pub market_revision: u64,
    pub offer_id: Option<u64>,
    pub trade_id: Option<u64>,
    pub listing_version: Option<u64>,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ActionSequence {
    last_action_id: u64,
    last_action: Option<LastAction>,
}

impl ActionSequence {
    pub fn last_action_id(&self) -> u64 {
        self.last_action_id
    }

    pub fn last_action(&self) -> Option<&LastAction> {
        self.last_action.as_ref()
    }

    pub fn next_action_id(&self) -> Result<u64, StateError> {
        checked_increment(self.last_action_id)
    }

    pub fn record(&mut self, action: LastAction) -> Result<(), StateError> {
        if action.action_id <= self.last_action_id {
            return Err(StateError::ActionUsed);
        }
        if action.action_id != self.next_action_id()? {
            return Err(StateError::ActionGap);
        }
        self.last_action_id = action.action_id;
        self.last_action = Some(action);
        Ok(())
    }
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, PartialEq, Eq)]
pub enum OfferStatus {
    Pending,
    Accepted,
    Cancelled,
    Expired,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, PartialEq, Eq)]
pub struct ActionRef {
    pub merchant_id: MerchantId,
    pub action_id: u64,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, PartialEq, Eq)]
pub struct Offer {
    pub offer_id: u64,
    pub proposer: MerchantId,
    pub buyer: MerchantId,
    pub seller: MerchantId,
    pub counterparty: MerchantId,
    pub resource: Resource,
    pub quantity: u64,
    pub unit_price: u64,
    pub total_price: u64,
    pub created_at_ns: u64,
    pub expires_at_ns: u64,
    pub status: OfferStatus,
    pub closed_at_ns: Option<u64>,
    pub settled_trade_id: Option<u64>,
    pub proposal_action: ActionRef,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, PartialEq, Eq)]
pub enum TradeKind {
    PlayerPurchase,
    MerchantTrade,
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, PartialEq, Eq)]
pub struct Trade {
    pub trade_id: u64,
    pub kind: TradeKind,
    pub buyer: Actor,
    pub seller: Actor,
    pub resource: Resource,
    pub quantity: u64,
    pub unit_price: u64,
    pub total_price: u64,
    pub offer_id: Option<u64>,
    pub buyer_gold_after: u64,
    pub seller_gold_after: u64,
    pub buyer_resource_after: u64,
    pub seller_resource_after: u64,
    pub settled_at_ns: u64,
    pub market_revision: u64,
}
