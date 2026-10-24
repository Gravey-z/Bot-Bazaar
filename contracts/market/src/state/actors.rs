use near_sdk::AccountId;

use super::{
    ActionSequence, Listing, MAX_ACTOR_GOLD, MAX_ACTOR_RESOURCE, StateError, checked_credit,
    checked_debit,
};

#[near_sdk::near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MerchantId {
    Rex,
    Luna,
    Bolt,
}

impl MerchantId {
    pub const ALL: [Self; 3] = [Self::Rex, Self::Luna, Self::Bolt];

    pub const fn index(self) -> usize {
        match self {
            Self::Rex => 0,
            Self::Luna => 1,
            Self::Bolt => 2,
        }
    }
}

#[near_sdk::near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Resource {
    Crystal,
    Wood,
    Herb,
    Iron,
}

impl Resource {
    pub const ALL: [Self; 4] = [Self::Crystal, Self::Wood, Self::Herb, Self::Iron];

    pub const fn index(self) -> usize {
        match self {
            Self::Crystal => 0,
            Self::Wood => 1,
            Self::Herb => 2,
            Self::Iron => 3,
        }
    }
}

#[near_sdk::near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Actor {
    Player { account_id: AccountId },
    Merchant { merchant_id: MerchantId },
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Inventory {
    quantities: [u64; 4],
}

impl Inventory {
    pub fn new(quantities: [u64; 4]) -> Result<Self, StateError> {
        if quantities
            .iter()
            .any(|quantity| *quantity > MAX_ACTOR_RESOURCE)
        {
            return Err(StateError::LimitExceeded);
        }
        Ok(Self { quantities })
    }

    pub fn amount(&self, resource: Resource) -> u64 {
        self.quantities[resource.index()]
    }

    pub fn credit(&mut self, resource: Resource, amount: u64) -> Result<(), StateError> {
        let current = self.amount(resource);
        self.quantities[resource.index()] = checked_credit(current, amount, MAX_ACTOR_RESOURCE)?;
        Ok(())
    }

    pub fn debit(&mut self, resource: Resource, amount: u64) -> Result<(), StateError> {
        self.quantities[resource.index()] = checked_debit(self.amount(resource), amount)?;
        Ok(())
    }
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    gold: u64,
    pub inventory: Inventory,
}

impl Balances {
    pub fn new(gold: u64, inventory: Inventory) -> Result<Self, StateError> {
        if gold > MAX_ACTOR_GOLD {
            return Err(StateError::LimitExceeded);
        }
        Ok(Self { gold, inventory })
    }

    pub fn gold(&self) -> u64 {
        self.gold
    }

    pub fn credit_gold(&mut self, amount: u64) -> Result<(), StateError> {
        self.gold = checked_credit(self.gold, amount, MAX_ACTOR_GOLD)?;
        Ok(())
    }

    pub fn debit_gold(&mut self, amount: u64) -> Result<(), StateError> {
        self.gold = checked_debit(self.gold, amount)?;
        Ok(())
    }
}

#[near_sdk::near(serializers = [borsh])]
#[derive(Debug, PartialEq, Eq)]
pub struct Player {
    pub account_id: AccountId,
    pub balances: Balances,
}

#[near_sdk::near(serializers = [borsh])]
pub struct Merchant {
    pub merchant_id: MerchantId,
    pub controller_account_id: AccountId,
    pub balances: Balances,
    pub listings: [Listing; 4],
    pub actions: ActionSequence,
    pub pending_offer_count: u8,
}
