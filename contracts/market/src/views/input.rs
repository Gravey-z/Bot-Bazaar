use near_sdk::serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, Visitor},
};
use near_sdk::serde_json::Value;
use near_sdk::{env, require};
use std::collections::BTreeMap;

#[derive(
    near_sdk::serde::Serialize, Deserialize, near_sdk::NearSchema, Clone, Copy, Debug, PartialEq, Eq,
)]
#[serde(crate = "near_sdk::serde", try_from = "String", into = "String")]
pub struct Decimal(#[schemars(with = "String")] pub u64);

impl TryFrom<String> for Decimal {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("BB:E_INVALID_ARGUMENT");
        }
        value.parse().map(Self).map_err(|_| "BB:E_INVALID_ARGUMENT")
    }
}

impl From<Decimal> for String {
    fn from(value: Decimal) -> Self {
        value.0.to_string()
    }
}

struct Input(BTreeMap<String, Value>);

impl<'de> Deserialize<'de> for Input {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Input;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an object with unique argument fields")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Input, A::Error> {
                let mut fields = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    if fields.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate argument"));
                    }
                }
                Ok(Input(fields))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

pub(crate) fn valid_input(bytes: &[u8], keys: &[&str]) -> bool {
    let Ok(Input(fields)) = near_sdk::serde_json::from_slice(bytes) else {
        return false;
    };
    fields.len() == keys.len()
        && keys.iter().all(|key| {
            fields.get(*key).is_some_and(|value| {
                value.is_string()
                    || (matches!(*key, "after_id" | "expected_revision") && value.is_null())
            })
        })
}

pub(crate) fn validate_input(keys: &[&str]) {
    let bytes = env::input().unwrap_or_default();
    require!(valid_input(&bytes, keys), "BB:E_INVALID_ARGUMENT");
}
