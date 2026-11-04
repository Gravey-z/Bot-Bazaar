import type { RegistrationObservation } from "./registration-reader";

// Each controller owns its accepted snapshot. Never let another request/account
// or a mutable object returned by a reader replace that ownership implicitly.
export function acceptPlayerObservation(
  value: RegistrationObservation,
  accountId: string,
  previous: RegistrationObservation | null,
  now: number,
): RegistrationObservation {
  const { market, player } = value;
  const chainTime = Number(BigInt(market.block_timestamp_ns) / 1000000n);
  if (
    value.accountId !== accountId ||
    (player.data && player.data.account_id !== accountId) ||
    market.block_height !== player.block_height ||
    market.market_revision !== player.market_revision ||
    market.block_timestamp_ns !== player.block_timestamp_ns ||
    now < value.receivedAt ||
    now - value.receivedAt > 15000 ||
    now - chainTime > 15000 ||
    chainTime - now > 5000
  )
    throw new Error("Player snapshot is unavailable, stale or inconsistent");
  if (
    previous &&
    (previous.accountId !== accountId ||
      previous.market.data.contract_account_id !==
        market.data.contract_account_id ||
      BigInt(market.block_height) < BigInt(previous.market.block_height) ||
      BigInt(market.market_revision) <
        BigInt(previous.market.market_revision) ||
      BigInt(market.block_timestamp_ns) <
        BigInt(previous.market.block_timestamp_ns) ||
      (previous.player.data && !player.data) ||
      (market.block_height === previous.market.block_height &&
        (market.block_timestamp_ns !== previous.market.block_timestamp_ns ||
          market.market_revision !== previous.market.market_revision ||
          JSON.stringify(market.data) !==
            JSON.stringify(previous.market.data) ||
          JSON.stringify(player.data) !==
            JSON.stringify(previous.player.data))))
  )
    throw new Error(
      "Player snapshot regressed or conflicts with an accepted block",
    );
  return structuredClone(value);
}
