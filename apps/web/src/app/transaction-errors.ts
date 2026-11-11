export class WalletRejectedError extends Error {
  constructor() {
    super("The wallet explicitly rejected this request.");
  }
}
// Pinned Meteor uses MeteorActionError._reason.endTags. Closing a window or
// losing the bridge is ambiguous; only an explicit sole cancellation tag counts.
export function isMeteorRejection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as {
    name?: unknown;
    _reason?: { endTags?: unknown };
    transaction?: unknown;
    transactionHash?: unknown;
  };
  if (
    error.transaction ||
    error.transactionHash ||
    error.name !== "MeteorActionError"
  )
    return false;
  const tags = error._reason?.endTags;
  return (
    Array.isArray(tags) && tags.length === 1 && tags[0] === "USER_CANCELLED"
  );
}
export class WalletConnectionError extends Error {
  constructor(readonly stage: "setup" | "network" | "handoff" | "cancelled") {
    super(
      {
        setup:
          "The wallet adapter could not load. Check browser storage and blocked scripts, then try again.",
        network:
          "The Testnet connection could not be verified. The wallet has not opened. Check your connection and try again.",
        handoff:
          "Meteor could not open or complete sign-in. Check blocked popups and wallet scripts, then try again.",
        cancelled:
          "Wallet connection was cancelled. You can try again anytime.",
      }[stage],
    );
  }
}
