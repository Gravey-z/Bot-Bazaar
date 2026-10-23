mod actors;
mod records;

pub use actors::*;
pub use records::*;

use near_sdk::borsh::BorshSerialize;
use near_sdk::{AccountId, BorshStorageKey, store::LookupMap};

pub const MAX_PLAYERS: u64 = 1_000;
pub const STARTER_GOLD: u64 = 100;
pub const MAX_ACTOR_GOLD: u64 = 1_000_000;
pub const MAX_ACTOR_RESOURCE: u64 = 1_000;
pub const MAX_QUANTITY: u64 = 100;
pub const MAX_UNIT_PRICE: u64 = 100;
pub const MAX_TOTAL_PRICE: u64 = 10_000;
pub const MAX_PENDING_PER_MERCHANT: u8 = 8;
pub const MAX_PENDING_OFFERS: usize = 12;
pub const RETAINED_HISTORY: usize = 100;
pub const MAX_PAGE_SIZE: u64 = 50;
pub const MAX_EXPIRE_BATCH: u64 = 24;
pub const MAX_OFFER_LIFETIME_NS: u64 = 600_000_000_000;

#[derive(Debug, PartialEq, Eq)]
pub enum StateError {
    Overflow,
    InsufficientBalance,
    LimitExceeded,
    InvalidListing,
    InvalidTrade,
    ActionUsed,
    ActionGap,
}

pub fn checked_credit(value: u64, amount: u64, maximum: u64) -> Result<u64, StateError> {
    let result = value.checked_add(amount).ok_or(StateError::Overflow)?;
    if result > maximum {
        return Err(StateError::LimitExceeded);
    }
    Ok(result)
}

pub fn checked_debit(value: u64, amount: u64) -> Result<u64, StateError> {
    value
        .checked_sub(amount)
        .ok_or(StateError::InsufficientBalance)
}

pub fn checked_increment(value: u64) -> Result<u64, StateError> {
    value.checked_add(1).ok_or(StateError::Overflow)
}

pub fn checked_trade_total(quantity: u64, unit_price: u64) -> Result<u64, StateError> {
    if !(1..=MAX_QUANTITY).contains(&quantity) || !(1..=MAX_UNIT_PRICE).contains(&unit_price) {
        return Err(StateError::InvalidTrade);
    }
    let total = quantity
        .checked_mul(unit_price)
        .ok_or(StateError::Overflow)?;
    if total > MAX_TOTAL_PRICE {
        return Err(StateError::LimitExceeded);
    }
    Ok(total)
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, PartialEq, Eq)]
pub struct IdSequence {
    next_id: u64,
}

impl Default for IdSequence {
    fn default() -> Self {
        Self { next_id: 1 }
    }
}

impl IdSequence {
    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    pub fn allocate(&mut self) -> Result<u64, StateError> {
        let next = checked_increment(self.next_id)?;
        let allocated = self.next_id;
        self.next_id = next;
        Ok(allocated)
    }
}

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
pub enum StorageKey {
    Players,
    Offers,
    Trades,
}

#[near_sdk::near(serializers = [borsh])]
pub struct MarketState {
    pub owner_account_id: AccountId,
    pub paused: bool,
    pub registered_player_count: u64,
    pub total_issued_gold: u64,
    pub resource_supply: Inventory,
    pub merchants: [Merchant; 3],
    pub players: LookupMap<AccountId, Player>,
    pub offers: LookupMap<u64, Offer>,
    pub trades: LookupMap<u64, Trade>,
    pub offer_ids: IdSequence,
    pub trade_ids: IdSequence,
    pub market_revision: u64,
    pub offers_pruned_through: u64,
    pub trades_pruned_through: u64,
    pub pending_offer_ids: [Option<u64>; MAX_PENDING_OFFERS],
    pub terminal_offer_ids: RetainedIds,
    pub trade_history_ids: RetainedIds,
}

#[near_sdk::near(serializers = [borsh])]
pub struct RetainedIds {
    pub slots: [Option<u64>; RETAINED_HISTORY],
    pub head: u8,
    pub count: u8,
}

impl Default for RetainedIds {
    fn default() -> Self {
        Self {
            slots: [None; RETAINED_HISTORY],
            head: 0,
            count: 0,
        }
    }
}

#[cfg(test)]
mod tests;
