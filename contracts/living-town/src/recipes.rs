use super::*;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecipeId {
    HealthPotion,
    IronTool,
}
impl RecipeId {
    fn key(self) -> &'static str {
        match self {
            Self::HealthPotion => "health_potion",
            Self::IronTool => "iron_tool",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Recipe {
    pub(super) recipe_id: RecipeId,
    version: u64,
    inputs: Inventory,
    pub(super) output_item: Item,
    output_per_unit: u64,
    duration_seconds: u64,
    max_batch_quantity: u64,
}
impl Recipe {
    pub fn versioned(id: RecipeId, version: u64) -> Self {
        require!(version == 1, "LT:E_UNKNOWN_RECIPE_VERSION");
        let cfg = config();
        let value = &cfg["economy"]["recipes"][id.key()];
        let integer = |v: &Value| -> u64 {
            v.as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| env::panic_str("LT:E_CONFIG_CHANGED"))
        };
        let mut counts = [0; 6];
        for (i, item) in ITEM_IDS.iter().enumerate() {
            if let Some(v) = value["inputs"].get(*item) {
                counts[i] = integer(v);
            }
        }
        Self {
            recipe_id: id,
            version,
            inputs: Inventory::new(counts),
            output_item: match id {
                RecipeId::HealthPotion => Item::HealthPotion,
                RecipeId::IronTool => Item::IronTool,
            },
            output_per_unit: 1,
            duration_seconds: integer(&value["seconds"]),
            max_batch_quantity: integer(&cfg["limits"]["max_batch_quantity"]),
        }
    }
    pub fn view(&self) -> Value {
        json!({"recipe_id":self.recipe_id,"version":self.version.to_string(),"inputs":self.inputs.view(),"output_item":self.output_item,"output_per_unit":self.output_per_unit.to_string(),"duration_seconds":self.duration_seconds.to_string(),"max_batch_quantity":self.max_batch_quantity.to_string()})
    }
    // P2.2 embeds these immutable values in each admitted job. This computes
    // terms only; it neither consumes inventory nor allocates a job/slot.
    pub fn terms(&self, config_version: u64, quantity: u64, start_at_ns: u64) -> ProductionTerms {
        require!(config_version > 0, "LT:E_CONFIG_CHANGED");
        require!(
            (1..=self.max_batch_quantity).contains(&quantity),
            "LT:E_INVALID_QUANTITY"
        );
        let multiply = |a: u64, b: u64| {
            a.checked_mul(b)
                .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"))
        };
        let inputs = self.inputs.quantities.map(|n| multiply(n, quantity));
        let output = multiply(self.output_per_unit, quantity);
        require!(output > 0 && output <= 1000, "LT:E_BALANCE_CAP");
        let duration_ns = multiply(multiply(self.duration_seconds, quantity), 1_000_000_000);
        let ready = start_at_ns
            .checked_add(duration_ns)
            .unwrap_or_else(|| env::panic_str("LT:E_ARITHMETIC_OVERFLOW"));
        ProductionTerms {
            recipe_id: self.recipe_id,
            recipe_version: self.version,
            config_version,
            quantity,
            inputs_consumed: Inventory::new(inputs),
            output_item: self.output_item,
            output_quantity: output,
            start_at_ns,
            ready_at_ns: ready,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ProductionTerms {
    pub(super) recipe_id: RecipeId,
    pub(super) recipe_version: u64,
    pub(super) config_version: u64,
    pub(super) quantity: u64,
    pub(super) inputs_consumed: Inventory,
    pub(super) output_item: Item,
    pub(super) output_quantity: u64,
    pub(super) start_at_ns: u64,
    pub(super) ready_at_ns: u64,
}
impl ProductionTerms {
    pub fn view(&self) -> Value {
        json!({"recipe_id":self.recipe_id,"recipe_version":self.recipe_version.to_string(),"config_version":self.config_version.to_string(),"quantity":self.quantity.to_string(),"inputs_consumed":self.inputs_consumed.view(),"output_item":self.output_item,"output_quantity":self.output_quantity.to_string(),"start_at_ns":self.start_at_ns.to_string(),"ready_at_ns":self.ready_at_ns.to_string()})
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PageArgs {
    after_id: Option<Decimal>,
    limit: Decimal,
    expected_market_revision: Decimal,
}
#[near]
impl LivingTown {
    pub fn get_recipes(
        &self,
        after_id: Option<Decimal>,
        limit: Decimal,
        expected_market_revision: Decimal,
    ) -> Value {
        let parsed: PageArgs = ownership::args(&["after_id", "limit", "expected_market_revision"]);
        require!(
            parsed.after_id == after_id
                && parsed.limit == limit
                && parsed.expected_market_revision == expected_market_revision,
            "LT:E_INVALID_ARGUMENT"
        );
        self.assert_versions();
        require!((1..=50).contains(&limit.0), "LT:E_INVALID_ARGUMENT");
        require!(
            expected_market_revision.0 == self.market_revision,
            "LT:E_STALE_MARKET"
        );
        let mut rows = Vec::new();
        let mut more = false;
        let mut cursor = after_id.map(|v| v.0);
        for (id, recipe) in [(1, RecipeId::HealthPotion), (2, RecipeId::IronTool)] {
            if after_id.is_some_and(|v| id <= v.0) {
                continue;
            }
            if rows.len() == limit.0 as usize {
                more = true;
                break;
            }
            rows.push(json!({"recipe_entry_id":id.to_string(),"recipe":Recipe::versioned(recipe,1).view()}));
            cursor = Some(id);
        }
        self.snapshot(json!({"items":rows,"next_after_id":cursor.map(|v|v.to_string()),"has_more":more,"history_gap":false,"pruned_through":"0"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context() {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
    }
    #[test]
    fn agreed_recipe_versions_and_linear_batches_are_exact() {
        context();
        for (id, seconds, inputs) in [
            (RecipeId::HealthPotion, 120, [1, 0, 2, 0, 0, 0]),
            (RecipeId::IronTool, 180, [0, 1, 0, 2, 0, 0]),
        ] {
            let recipe = Recipe::versioned(id, 1);
            assert_eq!(recipe.inputs.quantities, inputs);
            assert_eq!(recipe.duration_seconds, seconds);
            for q in [1, 10] {
                let terms = recipe.terms(1, q, 42);
                assert_eq!(terms.inputs_consumed.quantities, inputs.map(|n| n * q));
                assert_eq!(terms.output_quantity, q);
                assert_eq!(terms.ready_at_ns, 42 + q * seconds * 1_000_000_000);
            }
        }
    }
    #[test]
    fn frozen_terms_survive_borsh_reopen_and_later_recipe_tuning() {
        context();
        let mut recipe = Recipe::versioned(RecipeId::HealthPotion, 1);
        let terms = recipe.terms(1, 10, 42);
        let bytes = near_sdk::borsh::to_vec(&terms).unwrap();
        let before = terms.view();
        recipe.version = 2;
        recipe.duration_seconds = 1;
        recipe.inputs = Inventory::default();
        assert_ne!(recipe.terms(2, 10, 42).view(), before);
        let reopened: ProductionTerms = near_sdk::borsh::from_slice(&bytes).unwrap();
        assert_eq!(reopened.view(), before);
        assert_eq!(reopened.recipe_version, 1);
        assert_eq!(reopened.config_version, 1);
    }
    #[test]
    fn invalid_batches_versions_and_time_overflow_reject_without_changing_recipe() {
        context();
        let recipe = Recipe::versioned(RecipeId::IronTool, 1);
        let before = recipe.view();
        for (q, start) in [(0, 1), (11, 1), (u64::MAX, 1), (1, u64::MAX)] {
            assert!(
                std::panic::catch_unwind(
                    std::panic::AssertUnwindSafe(|| recipe.terms(1, q, start))
                )
                .is_err()
            );
            assert_eq!(recipe.view(), before);
        }
        assert!(std::panic::catch_unwind(|| Recipe::versioned(RecipeId::IronTool, 2)).is_err());
        let boundary = u64::MAX - 180_000_000_000;
        assert_eq!(recipe.terms(1, 1, boundary).ready_at_ns, u64::MAX);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| recipe.terms(
                1,
                1,
                boundary + 1
            )))
            .is_err()
        );
        let mut overflow = recipe.clone();
        overflow.duration_seconds = u64::MAX;
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| overflow.terms(1, 10, 1)))
                .is_err()
        );
        for raw in [r#""unknown""#, r#""crystal""#] {
            assert!(serde_json::from_str::<RecipeId>(raw).is_err());
        }
        for raw in [r#""0.5""#, r#"0.5"#, r#"1"#, r#""01""#] {
            assert!(serde_json::from_str::<Decimal>(raw).is_err());
        }
    }
}
