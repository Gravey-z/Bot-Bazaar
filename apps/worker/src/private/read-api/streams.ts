import type { IncomingMessage, ServerResponse } from "node:http";
import { livingTownActivityPage } from "@bot-bazaar/chain";
import { ReadApiError } from "../activity/repository.js";
type Page = ReturnType<typeof livingTownActivityPage>;
/** Pull committed durable rows; no network broadcast can run inside a projection transaction. */
export class LivingTownStreams {
  private readonly clients = new Map<
    ServerResponse,
    { peer: string; close: () => void }
  >();
  constructor(
    private readonly pollMs = 1000,
    private readonly heartbeatMs = 10000,
    private readonly lifetimeMs = 120000,
  ) {}
  open(
    request: IncomingMessage,
    response: ServerResponse,
    read: (after: string | null, limit: number) => Page,
    after: string | null,
    peer = request.socket.remoteAddress ?? "unknown",
  ): void {
    if (
      this.clients.size >= 16 ||
      [...this.clients.values()].filter((c) => c.peer === peer).length >= 2
    )
      throw new ReadApiError(503, "stream_capacity");
    const firstPage = read(after, 50);
    let page: Page | undefined = firstPage,
      cursor = after,
      closed = false;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    response.setTimeout(0);
    request.socket.setTimeout(0);
    response.flushHeaders();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      this.clients.delete(response);
      response.end();
    };
    const write = (frame: string) => {
      if (closed) return false;
      if (
        Buffer.byteLength(frame) > 20000 ||
        response.writableLength > 65536 ||
        !response.write(frame)
      ) {
        close();
        return false;
      }
      return true;
    };
    const send = () => {
      try {
        if (closed) return;
        if (!page) page = read(cursor, 50);
        for (const row of page.events) {
          if (
            !write(
              `id: ${row.cursor}\nevent: ${row.event.type}\ndata: ${JSON.stringify(row.event)}\n\n`,
            )
          )
            return;
          cursor = row.cursor;
        }
        if (!cursor) cursor = page.next_cursor;
        page = undefined;
      } catch (e) {
        const code = e instanceof ReadApiError ? e.code : "read_unavailable";
        write(
          `event: reset\ndata: ${JSON.stringify({ error: code, reset_required: ["feed_retention_gap", "feed_generation_mismatch", "cursor_deployment_mismatch"].includes(code) })}\n\n`,
        );
        close();
      }
    };
    const poll = setInterval(send, this.pollMs),
      heartbeat = setInterval(() => {
        write(": heartbeat\n\n");
      }, this.heartbeatMs),
      lifetime = setTimeout(close, this.lifetimeMs);
    this.clients.set(response, { peer, close });
    response.once("close", close);
    response.once("error", close);
    write("retry: 3000\n\n");
    write(
      `event: ready\ndata: ${JSON.stringify({ ...firstPage, events: [] })}\n\n`,
    );
    send();
  }
  close(): void {
    for (const client of this.clients.values()) client.close();
  }
}
