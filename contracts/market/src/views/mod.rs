pub(crate) mod input;
mod types;
pub use input::Decimal;
pub use types::*;

use crate::{Market, MarketExt, state::*};
use input::validate_input;
use near_sdk::{AccountId, env, json_types::U64, near, require};

#[near(serializers = [json])]
#[derive(Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum OfferFilter {
    All,
    Pending,
    Terminal,
}

impl Market {
    pub(crate) fn snapshot<T>(&self, data: T) -> Snapshot<T> {
        Snapshot {
            market_revision: U64(self.market.market_revision),
            block_height: U64(env::block_height()),
            block_timestamp_ns: U64(env::block_timestamp()),
            data,
        }
    }

    fn validate_page(&self, limit: Decimal, expected_revision: Option<Decimal>) {
        require!((1..=MAX_PAGE_SIZE).contains(&limit.0), "BB:E_INVALID_PAGE");
        require!(
            expected_revision.is_none_or(|revision| revision.0 == self.market.market_revision),
            "BB:E_STALE_SNAPSHOT"
        );
    }
}

fn page<T>(
    mut rows: Vec<(u64, T)>,
    after_id: Option<Decimal>,
    limit: Decimal,
    pruned_through: u64,
) -> Page<T> {
    rows.retain(|(id, _)| after_id.is_none_or(|after| *id > after.0));
    rows.sort_unstable_by_key(|(id, _)| *id);
    let has_more = rows.len() > limit.0 as usize;
    rows.truncate(limit.0 as usize);
    let next_after_id = rows
        .last()
        .map(|(id, _)| U64(*id))
        .or(after_id.map(|id| U64(id.0)));
    Page {
        items: rows.into_iter().map(|(_, item)| item).collect(),
        next_after_id,
        has_more,
        history_gap: pruned_through > 0 && after_id.is_none_or(|after| after.0 < pruned_through),
        pruned_through: U64(pruned_through),
    }
}

fn retained_ids(index: &RetainedIds) -> impl Iterator<Item = &u64> {
    (0..usize::from(index.count).min(RETAINED_HISTORY)).filter_map(move |offset| {
        index.slots[(usize::from(index.head) + offset) % RETAINED_HISTORY].as_ref()
    })
}

impl Market {
    pub(crate) fn market_snapshot(&self) -> Snapshot<MarketView> {
        let state = &self.market;
        self.snapshot(MarketView {
            api_version: "1.0.0".to_owned(),
            economy_version: "1".to_owned(),
            contract_account_id: env::current_account_id(),
            owner_account_id: state.owner_account_id.clone(),
            paused: state.paused,
            registered_player_count: U64(state.registered_player_count),
            total_issued_gold: U64(state.total_issued_gold),
            resource_supply: (&state.resource_supply).into(),
            merchants: state.merchants.iter().map(Into::into).collect(),
            next_offer_id: U64(state.offer_ids.next_id()),
            next_trade_id: U64(state.trade_ids.next_id()),
            offers_pruned_through: U64(state.offers_pruned_through),
            trades_pruned_through: U64(state.trades_pruned_through),
            limits: Limits::default(),
        })
    }
}

#[near]
impl Market {
    pub fn get_market_state(&self) -> Snapshot<MarketView> {
        validate_input(&[]);
        self.market_snapshot()
    }

    pub fn get_player(&self, account_id: AccountId) -> Snapshot<Option<PlayerView>> {
        validate_input(&["account_id"]);
        self.snapshot(self.market.players.get(&account_id).map(Into::into))
    }

    pub fn get_merchant(&self, merchant_id: MerchantId) -> Snapshot<MerchantView> {
        validate_input(&["merchant_id"]);
        self.snapshot((&self.market.merchants[merchant_id.index()]).into())
    }

    pub fn get_offer(&self, offer_id: Decimal) -> Snapshot<OfferLookup> {
        validate_input(&["offer_id"]);
        require!(offer_id.0 > 0, "BB:E_INVALID_ARGUMENT");
        let data = if let Some(offer) = self.market.offers.get(&offer_id.0) {
            OfferLookup::Found {
                offer: OfferView::at(offer, env::block_timestamp()),
            }
        } else if offer_id.0 < self.market.offer_ids.next_id() {
            OfferLookup::Pruned {
                offer_id: U64(offer_id.0),
            }
        } else {
            OfferLookup::NotFound {
                offer_id: U64(offer_id.0),
            }
        };
        self.snapshot(data)
    }

    pub fn get_offers_for_merchant(
        &self,
        merchant_id: MerchantId,
        status: OfferFilter,
        after_id: Option<Decimal>,
        limit: Decimal,
        expected_revision: Option<Decimal>,
    ) -> Snapshot<Page<OfferView>> {
        validate_input(&[
            "merchant_id",
            "status",
            "after_id",
            "limit",
            "expected_revision",
        ]);
        self.validate_page(limit, expected_revision);
        let now = env::block_timestamp();
        let rows = self
            .market
            .pending_offer_ids
            .iter()
            .flatten()
            .chain(retained_ids(&self.market.terminal_offer_ids))
            .filter_map(|id| self.market.offers.get(id))
            .filter(|offer| offer.buyer == merchant_id || offer.seller == merchant_id)
            .map(|offer| OfferView::at(offer, now))
            .filter(|offer| match status {
                OfferFilter::All => true,
                OfferFilter::Pending => offer.status == OfferStatus::Pending,
                OfferFilter::Terminal => offer.status != OfferStatus::Pending,
            })
            .map(|offer| (offer.offer_id.0, offer))
            .collect();
        self.snapshot(page(
            rows,
            after_id,
            limit,
            self.market.offers_pruned_through,
        ))
    }

    pub fn get_recent_trades(
        &self,
        after_id: Option<Decimal>,
        limit: Decimal,
        expected_revision: Option<Decimal>,
    ) -> Snapshot<Page<TradeView>> {
        validate_input(&["after_id", "limit", "expected_revision"]);
        self.validate_page(limit, expected_revision);
        let rows = retained_ids(&self.market.trade_history_ids)
            .filter_map(|id| self.market.trades.get(id))
            .map(|trade| (trade.trade_id, trade.into()))
            .collect();
        self.snapshot(page(
            rows,
            after_id,
            limit,
            self.market.trades_pruned_through,
        ))
    }
}

#[cfg(test)]
mod tests;
