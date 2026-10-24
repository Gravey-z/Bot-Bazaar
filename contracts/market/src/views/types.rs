use crate::state::{self, Actor, MerchantId, MerchantMethod, OfferStatus, Resource, TradeKind};
use near_sdk::{AccountId, json_types::U64, near};

#[near(serializers = [json])]
pub struct Snapshot<T> {
    pub market_revision: U64,
    pub block_height: U64,
    pub block_timestamp_ns: U64,
    pub data: T,
}

#[near(serializers = [json])]
pub struct InventoryView {
    pub crystal: U64,
    pub wood: U64,
    pub herb: U64,
    pub iron: U64,
}

impl From<&state::Inventory> for InventoryView {
    fn from(value: &state::Inventory) -> Self {
        Self {
            crystal: U64(value.amount(Resource::Crystal)),
            wood: U64(value.amount(Resource::Wood)),
            herb: U64(value.amount(Resource::Herb)),
            iron: U64(value.amount(Resource::Iron)),
        }
    }
}

#[near(serializers = [json])]
pub struct ListingView {
    pub merchant_id: MerchantId,
    pub resource: Resource,
    pub unit_price: U64,
    pub quantity: U64,
    pub active: bool,
    pub version: U64,
}

#[near(serializers = [json])]
pub struct PlayerView {
    pub account_id: AccountId,
    pub gold: U64,
    pub inventory: InventoryView,
}

impl From<&state::Player> for PlayerView {
    fn from(value: &state::Player) -> Self {
        Self {
            account_id: value.account_id.clone(),
            gold: U64(value.balances.gold()),
            inventory: (&value.balances.inventory).into(),
        }
    }
}

#[near(serializers = [json])]
pub struct LastActionView {
    pub action_id: U64,
    pub method: MerchantMethod,
    pub args_sha256: String,
    pub market_revision: U64,
    pub offer_id: Option<U64>,
    pub trade_id: Option<U64>,
    pub listing_version: Option<U64>,
}

impl From<&state::LastAction> for LastActionView {
    fn from(value: &state::LastAction) -> Self {
        use std::fmt::Write;
        let mut digest = String::with_capacity(64);
        for byte in value.args_sha256 {
            write!(&mut digest, "{byte:02x}").expect("writing to a String");
        }
        Self {
            action_id: U64(value.action_id),
            method: value.method,
            args_sha256: digest,
            market_revision: U64(value.market_revision),
            offer_id: value.offer_id.map(U64),
            trade_id: value.trade_id.map(U64),
            listing_version: value.listing_version.map(U64),
        }
    }
}

#[near(serializers = [json])]
pub struct MerchantView {
    pub merchant_id: MerchantId,
    pub controller_account_id: AccountId,
    pub gold: U64,
    pub inventory: InventoryView,
    pub listings: Vec<ListingView>,
    pub last_action_id: U64,
    pub last_action: Option<LastActionView>,
}

impl From<&state::Merchant> for MerchantView {
    fn from(value: &state::Merchant) -> Self {
        Self {
            merchant_id: value.merchant_id,
            controller_account_id: value.controller_account_id.clone(),
            gold: U64(value.balances.gold()),
            inventory: (&value.balances.inventory).into(),
            listings: Resource::ALL
                .into_iter()
                .map(|resource| {
                    let listing = value.listings[resource.index()];
                    ListingView {
                        merchant_id: value.merchant_id,
                        resource,
                        unit_price: U64(listing.unit_price),
                        quantity: U64(listing.quantity),
                        active: listing.active,
                        version: U64(listing.version),
                    }
                })
                .collect(),
            last_action_id: U64(value.actions.last_action_id()),
            last_action: value.actions.last_action().map(Into::into),
        }
    }
}

#[near(serializers = [json])]
pub struct ActionRefView {
    pub merchant_id: MerchantId,
    pub action_id: U64,
}

#[near(serializers = [json])]
pub struct OfferView {
    pub offer_id: U64,
    pub proposer: MerchantId,
    pub buyer: MerchantId,
    pub seller: MerchantId,
    pub counterparty: MerchantId,
    pub resource: Resource,
    pub quantity: U64,
    pub unit_price: U64,
    pub total_price: U64,
    pub created_at_ns: U64,
    pub expires_at_ns: U64,
    pub status: OfferStatus,
    pub closed_at_ns: Option<U64>,
    pub settled_trade_id: Option<U64>,
    pub proposal_action: ActionRefView,
}

impl OfferView {
    pub(crate) fn at(value: &state::Offer, now: u64) -> Self {
        let expired = value.status == OfferStatus::Pending && now >= value.expires_at_ns;
        Self {
            offer_id: U64(value.offer_id),
            proposer: value.proposer,
            buyer: value.buyer,
            seller: value.seller,
            counterparty: value.counterparty,
            resource: value.resource,
            quantity: U64(value.quantity),
            unit_price: U64(value.unit_price),
            total_price: U64(value.total_price),
            created_at_ns: U64(value.created_at_ns),
            expires_at_ns: U64(value.expires_at_ns),
            status: if expired {
                OfferStatus::Expired
            } else {
                value.status
            },
            closed_at_ns: if expired {
                Some(U64(value.expires_at_ns))
            } else {
                value.closed_at_ns.map(U64)
            },
            settled_trade_id: value.settled_trade_id.map(U64),
            proposal_action: ActionRefView {
                merchant_id: value.proposal_action.merchant_id,
                action_id: U64(value.proposal_action.action_id),
            },
        }
    }
}

#[near(serializers = [json])]
pub struct TradeView {
    pub trade_id: U64,
    pub kind: TradeKind,
    pub buyer: Actor,
    pub seller: Actor,
    pub resource: Resource,
    pub quantity: U64,
    pub unit_price: U64,
    pub total_price: U64,
    pub offer_id: Option<U64>,
    pub buyer_gold_after: U64,
    pub seller_gold_after: U64,
    pub buyer_resource_after: U64,
    pub seller_resource_after: U64,
    pub settled_at_ns: U64,
    pub market_revision: U64,
}

impl From<&state::Trade> for TradeView {
    fn from(value: &state::Trade) -> Self {
        Self {
            trade_id: U64(value.trade_id),
            kind: value.kind,
            buyer: value.buyer.clone(),
            seller: value.seller.clone(),
            resource: value.resource,
            quantity: U64(value.quantity),
            unit_price: U64(value.unit_price),
            total_price: U64(value.total_price),
            offer_id: value.offer_id.map(U64),
            buyer_gold_after: U64(value.buyer_gold_after),
            seller_gold_after: U64(value.seller_gold_after),
            buyer_resource_after: U64(value.buyer_resource_after),
            seller_resource_after: U64(value.seller_resource_after),
            settled_at_ns: U64(value.settled_at_ns),
            market_revision: U64(value.market_revision),
        }
    }
}

#[near(serializers = [json])]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OfferLookup {
    Found { offer: OfferView },
    Pruned { offer_id: U64 },
    NotFound { offer_id: U64 },
}

#[near(serializers = [json])]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_after_id: Option<U64>,
    pub has_more: bool,
    pub history_gap: bool,
    pub pruned_through: U64,
}

#[near(serializers = [json])]
pub struct Limits {
    pub max_players: U64,
    pub starter_gold: U64,
    pub max_actor_gold: U64,
    pub max_actor_resource: U64,
    pub max_trade_quantity: U64,
    pub max_listing_quantity: U64,
    pub max_unit_price: U64,
    pub max_total_price: U64,
    pub max_pending_offers_per_merchant: U64,
    pub max_offer_lifetime_ns: U64,
    pub max_page_size: U64,
    pub retained_trade_limit: U64,
    pub retained_terminal_offer_limit: U64,
    pub max_expire_batch: U64,
}

impl Default for Limits {
    fn default() -> Self {
        use state::*;
        Self {
            max_players: U64(MAX_PLAYERS),
            starter_gold: U64(STARTER_GOLD),
            max_actor_gold: U64(MAX_ACTOR_GOLD),
            max_actor_resource: U64(MAX_ACTOR_RESOURCE),
            max_trade_quantity: U64(MAX_QUANTITY),
            max_listing_quantity: U64(MAX_QUANTITY),
            max_unit_price: U64(MAX_UNIT_PRICE),
            max_total_price: U64(MAX_TOTAL_PRICE),
            max_pending_offers_per_merchant: U64(u64::from(MAX_PENDING_PER_MERCHANT)),
            max_offer_lifetime_ns: U64(MAX_OFFER_LIFETIME_NS),
            max_page_size: U64(MAX_PAGE_SIZE),
            retained_trade_limit: U64(RETAINED_HISTORY as u64),
            retained_terminal_offer_limit: U64(RETAINED_HISTORY as u64),
            max_expire_batch: U64(MAX_EXPIRE_BATCH),
        }
    }
}

#[near(serializers = [json])]
pub struct MarketView {
    pub api_version: String,
    pub economy_version: String,
    pub contract_account_id: AccountId,
    pub owner_account_id: AccountId,
    pub paused: bool,
    pub registered_player_count: U64,
    pub total_issued_gold: U64,
    pub resource_supply: InventoryView,
    pub merchants: Vec<MerchantView>,
    pub next_offer_id: U64,
    pub next_trade_id: U64,
    pub offers_pruned_through: U64,
    pub trades_pruned_through: U64,
    pub limits: Limits,
}
