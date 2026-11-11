use super::*;

// Exact schema-1 root field order. Existing collection/value encodings and
// prefixes are preserved; this must never deserialize the V1 Market root.
#[near(serializers = [borsh])]
pub(crate) struct LegacySchemaOne {
    state_schema: u8,
    config_version: u64,
    config_sha256: String,
    genesis_hash: String,
    genesis_time_ns: u64,
    owner: AccountId,
    operator: AccountId,
    controllers: [AccountId; 3],
    npcs: [Npc; 3],
    paused: bool,
    market_revision: u64,
    registered_player_count: u64,
    issued_grants: u128,
    next_shop_id: u64,
    players: LookupMap<AccountId, Player>,
    shops: LookupMap<u64, Shop>,
    commands: LookupMap<String, CommandRecord>,
    next_job_id: u64,
    jobs: LookupMap<u64, production::Job>,
    active_jobs: LookupMap<u64, u64>,
    second_active_jobs: LookupMap<u64, u64>,
    upgrade_burns: u128,
    recipe_inputs_consumed: [u128; 6],
    completed_outputs: [u128; 6],
    completed_jobs: std::collections::VecDeque<u64>,
    pruned_jobs_through: u64,
    next_trade_id: u64,
    trades: LookupMap<u64, purchases::Trade>,
    next_listing_id: u64,
    listing_slots: LookupMap<(u64, u8), u64>,
    listing_index: LookupMap<u64, (u64, u8)>,
    player_listings: LookupMap<u64, Listing>,
    customer_pool: customers::Pool,
    customer_topups: u128,
    customer_consumed: [u128; 6],
    raw_epochs: [u64; 4],
    treasury_epochs: [u64; 3],
    supplied_items: [u128; 6],
    treasury_burns: u128,
    next_market_event_id: u64,
    market_events: std::collections::VecDeque<market_events::MarketEvent>,
}

#[near]
impl LivingTown {
    #[init(ignore_state)]
    #[private]
    pub fn migrate_merchant_offers() -> Self {
        let _: EmptyArgs = input();
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "LT:E_UNAUTHORIZED"
        );
        let bytes =
            env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("LT:E_MIGRATION_SOURCE"));
        let old = near_sdk::borsh::from_slice::<LegacySchemaOne>(&bytes)
            .unwrap_or_else(|_| env::panic_str("LT:E_MIGRATION_SOURCE"));
        require!(
            old.state_schema == 1
                && old.config_version == 1
                && old.config_sha256 == config_digest(),
            "LT:E_MIGRATION_SOURCE"
        );
        let mut migrated = Self {
            state_schema: 2,
            config_version: old.config_version,
            config_sha256: old.config_sha256,
            genesis_hash: old.genesis_hash,
            genesis_time_ns: old.genesis_time_ns,
            owner: old.owner,
            operator: old.operator,
            controllers: old.controllers,
            npcs: old.npcs,
            paused: old.paused,
            market_revision: old.market_revision,
            registered_player_count: old.registered_player_count,
            issued_grants: old.issued_grants,
            next_shop_id: old.next_shop_id,
            players: old.players,
            shops: old.shops,
            commands: old.commands,
            next_job_id: old.next_job_id,
            jobs: old.jobs,
            active_jobs: old.active_jobs,
            second_active_jobs: old.second_active_jobs,
            upgrade_burns: old.upgrade_burns,
            recipe_inputs_consumed: old.recipe_inputs_consumed,
            completed_outputs: old.completed_outputs,
            completed_jobs: old.completed_jobs,
            pruned_jobs_through: old.pruned_jobs_through,
            next_trade_id: old.next_trade_id,
            trades: old.trades,
            next_listing_id: old.next_listing_id,
            listing_slots: old.listing_slots,
            listing_index: old.listing_index,
            player_listings: old.player_listings,
            customer_pool: old.customer_pool,
            customer_topups: old.customer_topups,
            customer_consumed: old.customer_consumed,
            raw_epochs: old.raw_epochs,
            treasury_epochs: old.treasury_epochs,
            supplied_items: old.supplied_items,
            treasury_burns: old.treasury_burns,
            next_market_event_id: old.next_market_event_id,
            market_events: old.market_events,
            next_offer_id: 1,
            offers: LookupMap::new(b"lt:v2:merchant-offers:1:".to_vec()),
            pending_offers: vec![],
            closed_offers: std::collections::VecDeque::new(),
            pruned_offer_through: 0,
            pending_offer_counts: [0; 3],
        };
        migrated.persist_economic_state(false);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({"standard":"bot_bazaar_living_town","version":"2.0.0","event":"merchant_offers_migrated","data":[{"from_state_schema":"1","to_state_schema":"2","market_revision":migrated.market_revision.to_string(),"economic_transfer":false}]})
        ));
        migrated
    }
}
