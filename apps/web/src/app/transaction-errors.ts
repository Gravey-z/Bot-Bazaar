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
