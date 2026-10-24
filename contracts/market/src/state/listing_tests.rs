use super::*;

#[test]
fn stock_decreases_clamp_listings_and_increment_once_even_without_a_clamp() {
    let listing = Listing::new(4, 6, true).unwrap();
    let clamped = listing.after_stock_change(10, 3).unwrap();
    assert_eq!(
        (
            clamped.unit_price,
            clamped.quantity,
            clamped.active,
            clamped.version
        ),
        (4, 3, true, 2)
    );
    let unchanged_quantity = listing.after_stock_change(10, 8).unwrap();
    assert_eq!(
        (unchanged_quantity.quantity, unchanged_quantity.version),
        (6, 2)
    );
    let depleted = listing.after_stock_change(10, 0).unwrap();
    assert_eq!(
        (depleted.quantity, depleted.active, depleted.version),
        (0, false, 2)
    );
    assert_eq!(listing, Listing::new(4, 6, true).unwrap());
}

#[test]
fn receiving_stock_never_expands_or_activates_a_listing() {
    let active = Listing::new(7, 2, true).unwrap();
    let replenished = active.after_stock_change(5, 10).unwrap();
    assert_eq!(
        (
            replenished.quantity,
            replenished.active,
            replenished.unit_price,
            replenished.version
        ),
        (2, true, 7, 2)
    );
    let inactive = Listing::new(7, 0, false).unwrap();
    let replenished = inactive.after_stock_change(0, 10).unwrap();
    assert_eq!(
        (
            replenished.quantity,
            replenished.active,
            replenished.unit_price,
            replenished.version
        ),
        (0, false, 7, 2)
    );
    let decreased = inactive.after_stock_change(10, 3).unwrap();
    assert_eq!(
        (decreased.quantity, decreased.active, decreased.version),
        (0, false, 2)
    );
}

#[test]
fn purchase_subtracts_sold_listing_units_instead_of_only_clamping_to_stock() {
    let listing = Listing::new(4, 6, true).unwrap();
    let partial = listing.after_purchase(2, 10).unwrap();
    assert_eq!(
        (partial.quantity, partial.active, partial.version),
        (4, true, 2)
    );
    let depleted = listing.after_purchase(6, 10).unwrap();
    assert_eq!(
        (depleted.quantity, depleted.active, depleted.version),
        (0, false, 2)
    );
    assert_eq!(partial.unit_price, 4);
}

#[test]
fn equal_stock_preserves_version_and_overflow_cannot_change_the_original() {
    let mut listing = Listing::new(4, 6, true).unwrap();
    listing.version = u64::MAX;
    assert_eq!(listing.after_stock_change(10, 10).unwrap(), listing);
    assert_eq!(listing.after_stock_change(10, 9), Err(StateError::Overflow));
    assert_eq!(listing.after_purchase(1, 10), Err(StateError::Overflow));
    assert_eq!(listing.version, u64::MAX);
    assert_eq!(listing.quantity, 6);
}

#[test]
fn inconsistent_stock_and_invalid_purchase_shapes_are_rejected() {
    let listing = Listing::new(4, 6, true).unwrap();
    assert_eq!(
        listing.after_stock_change(5, 8),
        Err(StateError::InvalidListing)
    );
    assert_eq!(
        listing.after_stock_change(10, 1001),
        Err(StateError::LimitExceeded)
    );
    assert_eq!(
        listing.after_stock_change(1001, 10),
        Err(StateError::LimitExceeded)
    );
    assert_eq!(
        listing.after_purchase(0, 10),
        Err(StateError::InvalidListing)
    );
    assert_eq!(
        listing.after_purchase(101, 1000),
        Err(StateError::InvalidListing)
    );
    assert_eq!(
        listing.after_purchase(7, 10),
        Err(StateError::InsufficientBalance)
    );
    assert_eq!(
        Listing::new(4, 0, false).unwrap().after_purchase(1, 10),
        Err(StateError::InvalidListing)
    );
}
