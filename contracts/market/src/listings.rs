use crate::{
    Decimal, LastActionView, ListingView, Market, MarketExt, Snapshot,
    state::{
        LastAction, MAX_QUANTITY, MAX_UNIT_PRICE, MerchantId, MerchantMethod, Resource,
        checked_increment,
    },
    views::input::validate_input,
};
use near_sdk::{
    env,
    json_types::U64,
    near, require,
    serde_json::{self, Value},
};

#[near(serializers = [json])]
pub struct ListingResult {
    pub listing: ListingView,
    pub action: LastActionView,
}

pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<_> = fields.keys().collect();
            keys.sort_unstable();
            let items: Vec<_> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key"),
                        canonical_json(&fields[key])
                    )
                })
                .collect();
            format!("{{{}}}", items.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

#[near]
impl Market {
    #[allow(clippy::too_many_arguments)]
    pub fn set_listing(
        &mut self,
        merchant_id: MerchantId,
        resource: Resource,
        unit_price: Decimal,
        quantity: Decimal,
        active: bool,
        expected_version: Decimal,
        action_id: Decimal,
    ) -> Snapshot<ListingResult> {
        validate_input(&[
            "merchant_id",
            "resource",
            "unit_price",
            "quantity",
            "active",
            "expected_version",
            "action_id",
        ]);
        let merchant = &self.market.merchants[merchant_id.index()];
        require!(
            env::predecessor_account_id() == merchant.controller_account_id,
            "BB:E_UNAUTHORIZED"
        );
        require!(!self.market.paused, "BB:E_MARKET_PAUSED");
        crate::actions::validate_action(&merchant.actions, action_id.0);
        let current = merchant.listings[resource.index()];
        require!(current.version == expected_version.0, "BB:E_STALE_LISTING");
        require!(
            (1..=MAX_UNIT_PRICE).contains(&unit_price.0),
            "BB:E_INVALID_PRICE"
        );
        require!(
            quantity.0 <= MAX_QUANTITY && active == (quantity.0 > 0),
            "BB:E_INVALID_QUANTITY"
        );
        require!(
            quantity.0 <= merchant.balances.inventory.amount(resource),
            "BB:E_INSUFFICIENT_STOCK"
        );
        require!(
            current.unit_price != unit_price.0
                || current.quantity != quantity.0
                || current.active != active,
            "BB:E_NO_CHANGE"
        );
        let version = checked_increment(current.version)
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        let revision = checked_increment(self.market.market_revision)
            .unwrap_or_else(|_| env::panic_str("BB:E_ARITHMETIC_OVERFLOW"));
        let args = serde_json::json!({
            "merchant_id":merchant_id,"resource":resource,"unit_price":unit_price,
            "quantity":quantity,"active":active,"expected_version":expected_version,"action_id":action_id
        });
        let canonical = canonical_json(&serde_json::json!({"method":"set_listing","args":args}));
        let action = LastAction {
            action_id: action_id.0,
            method: MerchantMethod::SetListing,
            args_sha256: env::sha256_array(canonical.as_bytes()),
            market_revision: revision,
            offer_id: None,
            trade_id: None,
            listing_version: Some(version),
        };
        let action_view = (&action).into();
        let merchant = &mut self.market.merchants[merchant_id.index()];
        merchant
            .actions
            .record(action)
            .unwrap_or_else(|_| env::panic_str("BB:E_INVALID_ARGUMENT:invalid action sequence"));
        merchant.listings[resource.index()] = crate::state::Listing {
            unit_price: unit_price.0,
            quantity: quantity.0,
            active,
            version,
        };
        self.market.market_revision = revision;
        self.event_snapshot(
            "set_listing",
            ListingResult {
                listing: ListingView {
                    merchant_id,
                    resource,
                    unit_price: U64(unit_price.0),
                    quantity: U64(quantity.0),
                    active,
                    version: U64(version),
                },
                action: action_view,
            },
        )
    }
}

#[cfg(test)]
mod tests;
