use bot_bazaar_market::state::*;
use near_sdk::{PanicOnDefault, near, require};

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn forward_listing() {
    near_sdk::env::setup_panic_hook();
    let input: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_slice(&near_sdk::env::input().unwrap()).unwrap();
    let target = input["contract_id"].as_str().unwrap().parse().unwrap();
    let _ = near_sdk::Promise::new(target)
        .function_call(
            "set_listing".to_owned(),
            near_sdk::serde_json::to_vec(&input["args"]).unwrap(),
            near_sdk::NearToken::from_yoctonear(0),
            near_sdk::Gas::from_tgas(30),
        )
        .as_return();
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn forward_registration() {
    near_sdk::env::setup_panic_hook();
    let input: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_slice(&near_sdk::env::input().unwrap()).unwrap();
    let target = input["contract_id"].as_str().unwrap().parse().unwrap();
    let _ = near_sdk::Promise::new(target)
        .function_call(
            "register_player".to_owned(),
            b"{}".to_vec(),
            near_sdk::NearToken::from_yoctonear(0),
            near_sdk::Gas::from_tgas(30),
        )
        .as_return();
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn forward_admin() {
    near_sdk::env::setup_panic_hook();
    let input: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_slice(&near_sdk::env::input().unwrap()).unwrap();
    let target = input["contract_id"].as_str().unwrap().parse().unwrap();
    let method = input["method"].as_str().unwrap().to_owned();
    require!(
        matches!(method.as_str(), "pause_market" | "resume_market"),
        "invalid fixture method"
    );
    let _ = near_sdk::Promise::new(target)
        .function_call(
            method,
            b"{}".to_vec(),
            near_sdk::NearToken::from_yoctonear(0),
            near_sdk::Gas::from_tgas(30),
        )
        .as_return();
}

#[cfg(target_arch = "wasm32")]
fn invoke(method: fn(&mut StorageFixture, u64)) {
    near_sdk::env::setup_panic_hook();
    let input: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_slice(&near_sdk::env::input().unwrap()).unwrap();
    let count = input
        .get("count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let mut fixture: StorageFixture = near_sdk::env::state_read().unwrap();
    method(&mut fixture, count);
    near_sdk::env::state_write(&fixture);
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn fill_players() {
    invoke(StorageFixture::fill_players);
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn fill_history() {
    invoke(StorageFixture::fill_history);
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn fill_pending() {
    invoke(|fixture, _| fixture.fill_pending());
}

#[near]
#[derive(PanicOnDefault)]
pub struct StorageFixture {
    market: MarketState,
}

fn offer(id: u64, buyer: MerchantId, seller: MerchantId, deadline: u64) -> Offer {
    Offer {
        offer_id: id,
        proposer: buyer,
        buyer,
        seller,
        counterparty: seller,
        resource: Resource::Crystal,
        quantity: 1,
        unit_price: 1,
        total_price: 1,
        created_at_ns: 0,
        expires_at_ns: deadline,
        status: OfferStatus::Pending,
        closed_at_ns: None,
        settled_trade_id: None,
        proposal_action: ActionRef {
            merchant_id: buyer,
            action_id: id,
        },
    }
}

impl StorageFixture {
    pub fn fill_players(&mut self, count: u64) {
        require!(count <= 100, "fixture batch too large");
        for _ in 0..count {
            let id = self.market.registered_player_count;
            self.market
                .add_player(format!("{id:064}").parse().unwrap())
                .unwrap();
        }
    }

    pub fn fill_history(&mut self, count: u64) {
        require!(count <= 10, "fixture batch too large");
        if self.market.offer_ids.next_id() == 1 {
            self.market
                .insert_pending_offer(offer(1, MerchantId::Rex, MerchantId::Luna, u64::MAX))
                .unwrap();
        }
        for _ in 0..count {
            let id = self.market.offer_ids.next_id();
            self.market
                .insert_pending_offer(offer(id, MerchantId::Luna, MerchantId::Bolt, 10))
                .unwrap();
            let trade_id = self.market.trade_ids.next_id();
            self.market
                .close_offer(id, OfferStatus::Accepted, 1, Some(trade_id))
                .unwrap();
            self.market
                .append_trade(Trade {
                    trade_id,
                    kind: TradeKind::PlayerPurchase,
                    buyer: Actor::Player {
                        account_id: format!("{:064}", 0).parse().unwrap(),
                    },
                    seller: Actor::Merchant {
                        merchant_id: MerchantId::Luna,
                    },
                    resource: Resource::Crystal,
                    quantity: 1,
                    unit_price: 1,
                    total_price: 1,
                    offer_id: None,
                    buyer_gold_after: 99,
                    seller_gold_after: 221,
                    buyer_resource_after: 1,
                    seller_resource_after: 11,
                    settled_at_ns: 1,
                    market_revision: self.market.market_revision,
                })
                .unwrap();
        }
    }

    pub fn fill_pending(&mut self) {
        for (buyer, seller, count) in [
            (MerchantId::Rex, MerchantId::Luna, 3),
            (MerchantId::Rex, MerchantId::Bolt, 4),
            (MerchantId::Luna, MerchantId::Bolt, 4),
        ] {
            for _ in 0..count {
                let id = self.market.offer_ids.next_id();
                self.market
                    .insert_pending_offer(offer(id, buyer, seller, 1))
                    .unwrap();
            }
        }
        for merchant in &mut self.market.merchants {
            merchant
                .actions
                .record(LastAction {
                    action_id: 1,
                    method: MerchantMethod::AcceptTrade,
                    args_sha256: [0xff; 32],
                    market_revision: self.market.market_revision,
                    offer_id: Some(1),
                    trade_id: Some(1),
                    listing_version: Some(1),
                })
                .unwrap();
        }
        self.market.paused = true;
    }
}
