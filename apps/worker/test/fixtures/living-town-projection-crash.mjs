import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { LivingTownProjectionStore } from "../../dist/private/living-town/store.js";
import { createReadServer } from "../../dist/private/read-api/server.js";
import { readLivingTownHealth } from "../../dist/private/living-town/health.js";
import {
  initial,
  final,
  basicIdentity,
  basicRecords,
} from "./living-town-feed.mjs";
const [dir, point] = process.argv.slice(2),
  die = () => {
    writeFileSync(join(dir, "crash-marker.json"), JSON.stringify({ point }));
    process.kill(process.pid, "SIGKILL");
  };
process.once("exit", (code) =>
  writeFileSync(join(dir, "graceful-exit.json"), JSON.stringify({ code })),
);
const timer = setTimeout(() => process.exit(99), 10000);
const store = new LivingTownProjectionStore(dir, basicIdentity, true);
store.baseline(initial);
const sale = basicRecords.find(
  (r) =>
    r.status.kind === "succeeded" &&
    r.status.result.data.outcome.kind === "raw_purchased",
);
store.commit(sale);
if (
  point === "before_projection_commit" ||
  point === "after_projection_commit"
) {
  const transaction = store.transaction.bind(store);
  store.transaction = (work) =>
    transaction(() => {
      work();
      if (point === "before_projection_commit") die();
    });
  store.baseline(final, Date.now(), true);
  die();
}
store.baseline(final, Date.now(), true);
const server = createReadServer(
  {
    health: () => readLivingTownHealth(store),
    activity: () => {
      throw Error("not V1");
    },
    livingTown: {
      town: () => store.town(),
      shop: () => null,
      inventory: () => null,
      production: () => null,
      events: (after, limit) => {
        const page = store.events(after, limit);
        if (point === "before_broadcast") die();
        return page;
      },
    },
  },
  {
    allowedOrigins: [],
    trustedProxyIps: [],
    clientPerMinute: 60,
    globalPerSecond: 10,
  },
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/events/stream`,
  ),
  reader = response.body.getReader(),
  decoder = new TextDecoder();
let buffer = "";
while (true) {
  const part = await reader.read();
  if (part.done) break;
  buffer += decoder.decode(part.value, { stream: true });
  let end;
  while ((end = buffer.indexOf("\n\n")) >= 0) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    if (frame.includes("event: sale_confirmed")) {
      writeFileSync(
        join(dir, "client-ack.json"),
        JSON.stringify({
          cursor: /^id: (.+)$/m.exec(frame)[1],
          event: JSON.parse(/^data: (.+)$/m.exec(frame)[1]),
        }),
      );
      die();
    }
  }
}
clearTimeout(timer);
process.exit(99);
