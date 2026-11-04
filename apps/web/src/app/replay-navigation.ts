export function isReplayPage(page: string): boolean {
  return new URL(page).searchParams.get("view") === "replay";
}
// Preserve callback parameters and the tab's storage namespaces. Only a full
// return to live may interpret/reconcile an original wallet callback.
export function replayPageUrl(page: string, historical: boolean): string {
  const url = new URL(page);
  if (historical) url.searchParams.set("view", "replay");
  else url.searchParams.delete("view");
  url.hash = historical ? "" : "marketplace";
  return url.href;
}
