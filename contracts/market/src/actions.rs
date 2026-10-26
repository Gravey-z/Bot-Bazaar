use crate::state::{ActionSequence, StateError};
use near_sdk::env;

pub(crate) fn validate_action(sequence: &ActionSequence, action_id: u64) {
    sequence
        .validate_next(action_id)
        .unwrap_or_else(|error| match error {
            StateError::ActionUsed => env::panic_str("BB:E_ACTION_USED"),
            StateError::ActionGap => env::panic_str("BB:E_ACTION_GAP"),
            StateError::Overflow => env::panic_str("BB:E_ARITHMETIC_OVERFLOW"),
            _ => env::panic_str("BB:E_INVALID_ARGUMENT:invalid action sequence"),
        });
}

#[cfg(test)]
mod tests;
