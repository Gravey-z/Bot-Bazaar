import {
  parseReplayCollection,
  validateReplay,
  replayFileLimit,
} from "@bot-bazaar/chain";
import type { Replay, ReplayCollection, ReplayEntry } from "@bot-bazaar/chain";

export class ReplayLoadError extends Error {
  constructor() {
    super(
      "The historical archive is unavailable or did not pass its evidence checks. No live values were changed.",
    );
  }
}
export async function replayDigest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export class ReplayLoader {
  private readonly root: URL;
  constructor(
    base: URL,
    private readonly fetcher: typeof fetch = fetch,
    private readonly digest = replayDigest,
  ) {
    this.root = new URL("replays/", base);
    if (
      !["http:", "https:"].includes(this.root.protocol) ||
      this.root.username ||
      this.root.password
    )
      throw new ReplayLoadError();
  }
  private async bytes(
    file: string,
    maximum: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.fetcher(new URL(file, this.root), {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (
      !response.ok ||
      !response.body ||
      (response.url && new URL(response.url).origin !== this.root.origin)
    )
      throw new ReplayLoadError();
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > maximum) throw new ReplayLoadError();
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (signal.aborted) throw new ReplayLoadError();
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
  async index(signal: AbortSignal): Promise<ReplayCollection> {
    try {
      const bytes = await this.bytes("index.json", replayFileLimit, signal);
      return parseReplayCollection(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        bytes.length,
      );
    } catch {
      throw new ReplayLoadError();
    }
  }
  async load(entry: ReplayEntry, signal: AbortSignal): Promise<Replay> {
    try {
      // Validate caller-supplied entries too; a filename can never choose an RPC
      // endpoint, local file, parent path or external archive host.
      const checked = parseReplayCollection(
        { schema: "bot-bazaar-replay-collection-v1", entries: [entry] },
        1,
      ).entries[0]!;
      const bytes = await this.bytes(checked.file, checked.bytes, signal);
      if (
        bytes.length !== checked.bytes ||
        (await this.digest(bytes)) !== checked.sha256
      )
        throw new ReplayLoadError();
      const replay = await validateReplay(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        signal.aborted ||
        replay.mode !== "historical_replay" ||
        replay.runId !== checked.runId ||
        replay.identity.contractId !== checked.contractId ||
        replay.recordedFrom !== checked.recordedFrom ||
        replay.recordedTo !== checked.recordedTo ||
        Date.parse(replay.verification.verifiedAt) >
          Date.parse(checked.review.reviewedAt)
      )
        throw new ReplayLoadError();
      return replay;
    } catch {
      throw new ReplayLoadError();
    }
  }
}
