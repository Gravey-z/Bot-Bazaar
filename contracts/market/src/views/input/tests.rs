use super::*;
use crate::{OfferFilter, state::*};
use near_sdk::{
    AccountId,
    serde::de::DeserializeOwned,
    serde_json::{self, json},
};

#[test]
fn decimals_round_trip_without_rounding_and_reject_negative_malformed_or_oversized_values() {
    for value in [0, 1, 9_007_199_254_740_993, u64::MAX] {
        let wire = serde_json::to_value(Decimal(value)).unwrap();
        assert_eq!(wire, json!(value.to_string()));
        assert_eq!(serde_json::from_value::<Decimal>(wire).unwrap().0, value);
    }
    for value in [
        json!(-1),
        json!(1),
        json!(1.5),
        json!(null),
        json!(true),
        json!([]),
        json!({}),
        json!("-0"),
        json!("-1"),
        json!("+1"),
        json!("00"),
        json!("01"),
        json!(" 1"),
        json!("1\n"),
        json!("1.0"),
        json!("1e3"),
        json!("0x10"),
        json!("１"),
        json!("١"),
        json!(""),
        json!("18446744073709551616"),
        json!("9".repeat(1000)),
    ] {
        assert!(
            serde_json::from_value::<Decimal>(value.clone()).is_err(),
            "{value}"
        );
    }
}

fn enum_rejections<T: DeserializeOwned>() {
    for value in [
        json!(""),
        json!("other"),
        json!("REX"),
        json!("rex "),
        json!("gold"),
        json!("0"),
        json!(0),
        json!(null),
        json!(true),
        json!([]),
    ] {
        assert!(
            serde_json::from_value::<T>(value.clone()).is_err(),
            "{value}"
        );
    }
}

#[test]
fn enum_and_account_allowlists_reject_unknown_or_invalid_wire_identities() {
    for (id, name) in MerchantId::ALL.into_iter().zip(["rex", "luna", "bolt"]) {
        assert_eq!(serde_json::to_value(id).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<MerchantId>(json!(name)).unwrap(),
            id
        );
    }
    for (id, name) in Resource::ALL
        .into_iter()
        .zip(["crystal", "wood", "herb", "iron"])
    {
        assert_eq!(serde_json::to_value(id).unwrap(), json!(name));
        assert_eq!(serde_json::from_value::<Resource>(json!(name)).unwrap(), id);
    }
    enum_rejections::<MerchantId>();
    enum_rejections::<Resource>();
    enum_rejections::<OfferFilter>();
    enum_rejections::<MerchantMethod>();
    enum_rejections::<OfferStatus>();
    for name in [
        "",
        "a",
        "UPPER.testnet",
        "alice..testnet",
        ".alice",
        "alice.",
        "alice@testnet",
    ] {
        assert!(serde_json::from_value::<AccountId>(json!(name)).is_err());
    }
    assert!(serde_json::from_value::<AccountId>(json!("a".repeat(65))).is_err());
    for name in ["aa", "player.testnet", &"a".repeat(64)] {
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<AccountId>(json!(name)).unwrap())
                .unwrap(),
            json!(name)
        );
    }
    for actor in [
        json!({"kind":"merchant","merchant_id":"other"}),
        json!({"kind":"merchant","merchant_id":"rex","account_id":"x.testnet"}),
        json!({"kind":"player","account_id":"UPPER.testnet"}),
        json!({"kind":"player","account_id":"player.testnet","extra":"x"}),
        json!({"kind":"owner","account_id":"owner.testnet"}),
    ] {
        assert!(serde_json::from_value::<Actor>(actor).is_err());
    }
}

#[test]
fn raw_input_filter_rejects_ambiguous_json_and_only_permits_declared_nullable_shapes() {
    for bytes in [
        b"".as_slice(),
        b"null",
        b"[]",
        b"true",
        b"{}{}",
        b"{",
        b"{\"action_id\":\"1\",}",
        b"\xff",
        br#"{"action_id":"1","action\u005fid":"2"}"#,
        br#"{"action_id":"1","action_id":"1"}"#,
    ] {
        assert!(!valid_input(bytes, &["action_id"]));
    }
    assert!(!valid_input(
        br#"{"merchant_id":{"rex":null}}"#,
        &["merchant_id"]
    ));
    for key in ["offer_id", "action_id", "limit", "merchant_id", "resource"] {
        let mut args = serde_json::Map::new();
        args.insert(key.to_owned(), Value::Null);
        assert!(!valid_input(&serde_json::to_vec(&args).unwrap(), &[key]));
    }
    assert!(valid_input(
        br#"{"after_id":null,"expected_revision":null}"#,
        &["after_id", "expected_revision"]
    ));
    assert!(valid_input(
        br#"{"active":false,"offer_ids":["1","2"]}"#,
        &["active", "offer_ids"]
    ));
    for value in [json!(null), json!([1]), json!([null]), json!(["1", false])] {
        assert!(!valid_input(
            &serde_json::to_vec(&json!({"offer_ids":value})).unwrap(),
            &["offer_ids"]
        ));
    }
    for value in [json!("1"), json!(["-1"]), json!(["01"])] {
        assert!(serde_json::from_value::<Vec<Decimal>>(value).is_err());
    }
}
