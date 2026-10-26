use crate::{Market, Snapshot};
use near_sdk::{env, serde::Serialize, serde_json::json};

pub(crate) fn emit<T: Serialize>(method: &str, snapshot: &Snapshot<T>) {
    let event = json!({
        "standard":"bot_bazaar", "version":"1.0.0", "event":method,
        "data":[{
            "initiator_account_id":env::predecessor_account_id(),
            "market_revision":snapshot.market_revision,
            "block_height":snapshot.block_height,
            "block_timestamp_ns":snapshot.block_timestamp_ns,
            "result":snapshot.data,
        }],
    });
    env::log_str(&format!("EVENT_JSON:{event}"));
}

impl Market {
    pub(crate) fn event_snapshot<T: Serialize>(&self, method: &str, data: T) -> Snapshot<T> {
        let snapshot = self.snapshot(data);
        emit(method, &snapshot);
        snapshot
    }
}

#[cfg(test)]
mod tests;
