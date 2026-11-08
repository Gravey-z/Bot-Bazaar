import { randomUUID } from "node:crypto";
import {
  EconomyModel,
  economy,
  decimalReport,
} from "../../tests/scenarios/living-town-economy.mjs";

export class RehearsalSession {
  constructor() {
    this.reset();
  }
  reset() {
    this.id = randomUUID();
    this.model = new EconomyModel();
    this.shop = null;
    this.log = [];
    this.requests = new Map();
    this.firstSale = null;
    this.upgradeAt = null;
    this.startedAt = Date.now();
  }
  snapshot() {
    const m = this.model,
      s = m.state;
    return decimalReport({
      mode: "local_rehearsal",
      wallet: false,
      blockchain: false,
      ai: false,
      sessionId: this.id,
      elapsedWallSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      simulatedSeconds: s.now,
      clock: "manual",
      economyVersion: economy.economyVersion,
      registered: s.player !== null,
      shop: this.shop,
      gold: s.player,
      slots: s.slots,
      customerGold: s.customer,
      firstSale: this.firstSale,
      upgradeAt: this.upgradeAt,
      accounting: {
        grant: s.player === null ? 0n : BigInt(economy.starterGold),
        purchases: s.purchases,
        revenue: s.revenue,
        cogs: s.cogs,
        profit: s.revenue - s.cogs,
        upgrade: s.upgradeSpending,
        cashChange:
          s.player === null ? 0n : s.player - BigInt(economy.starterGold),
      },
      materials: Object.entries(economy.materials).map(([id, row]) => ({
        id,
        supplier: row.supplier,
        price: s.stock[id].price,
        stock: s.stock[id].listed,
        held: m.held(id),
        available: m.available(id),
      })),
      recipes: Object.entries(economy.recipes).map(([id, row]) => ({
        id,
        ...row,
        held: m.held(id),
        available: m.available(id),
        listing: s.listings[id] ?? null,
      })),
      jobs: Object.entries(s.jobs).map(([id, job]) => ({
        id,
        ...job,
        claimable: !job.completed && s.now >= job.ready,
      })),
      log: this.log,
    });
  }
  act(input) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      input.sessionId !== this.id ||
      typeof input.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(input.id)
    )
      throw Error(
        "Session changed or request identity invalid. Refresh the page.",
      );
    const payload = JSON.stringify(input),
      saved = this.requests.get(input.id);
    if (saved) {
      if (saved !== payload)
        throw Error("Request identity reused with different terms.");
      return this.snapshot();
    }
    if (input.action === "reset") {
      this.reset();
      return this.snapshot();
    }
    if (this.requests.size >= 2000)
      throw Error(
        "Rehearsal limit reached. Export your notes, then start a fresh rehearsal.",
      );
    const before = structuredClone(this.model.state),
      oldShop = this.shop;
    const oldFirstSale = this.firstSale,
      oldUpgrade = this.upgradeAt;
    const m = this.model,
      s = m.state,
      id = input.id;
    const positive = (value, max) => {
      if (
        typeof value !== "string" ||
        !/^[1-9][0-9]{0,3}$/.test(value) ||
        BigInt(value) > BigInt(max)
      )
        throw Error(`Enter a whole number from 1 to ${max}.`);
      return BigInt(value);
    };
    let note;
    try {
      if (input.action === "register") {
        m.register(id);
        note = "Registered once: 100 simulated game gold; no native fees.";
      } else if (input.action === "claim") {
        m.requirePlayer();
        if (this.shop) throw Error("This rehearsal already has a shop.");
        if (
          typeof input.name !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/.test(input.name)
        )
          throw Error(
            "Use a shop name of 1–32 letters, numbers, spaces, _ or -.",
          );
        this.shop = input.name;
        note = `Claimed ${this.shop}; no second grant.`;
      } else {
        if (!this.shop)
          throw Error("Register and claim your rehearsal shop first.");
        switch (input.action) {
          case "buy": {
            if (!Object.hasOwn(economy.materials, input.item))
              throw Error("Unknown material.");
            const amount = positive(input.quantity, 100),
              spent = m.buy(id, input.item, amount);
            note = `Bought ${amount} ${input.item} for ${spent} simulated gold.`;
            break;
          }
          case "start": {
            if (!Object.hasOwn(economy.recipes, input.item))
              throw Error("Unknown recipe.");
            const amount = positive(input.quantity, 10);
            m.start(id, input.item, amount);
            note = `Started ${amount} ${input.item}; whole batch ready at simulated second ${s.jobs[id].ready}.`;
            break;
          }
          case "claim-output": {
            if (
              typeof input.job !== "string" ||
              !Object.hasOwn(s.jobs, input.job)
            )
              throw Error("Unknown batch.");
            if (s.jobs[input.job].completed)
              throw Error("Output already claimed; no second credit.");
            const count = m.complete(input.job);
            note = `Claimed whole batch: ${count} ${s.jobs[input.job].product}.`;
            break;
          }
          case "list": {
            if (!Object.hasOwn(economy.recipes, input.item))
              throw Error("Unknown product.");
            const quantity = positive(input.quantity, 100),
              price = positive(input.price, 100);
            m.list(id, input.item, quantity, price);
            note = `Listed ${quantity} ${input.item} at ${price} simulated gold each.`;
            break;
          }
          case "cancel": {
            if (!Object.hasOwn(economy.recipes, input.item))
              throw Error("Unknown product.");
            m.list(id, input.item, 0n, 1n);
            note = `Cancelled ${input.item} listing; held stock retained.`;
            break;
          }
          case "advance": {
            const seconds = positive(input.seconds, 3600);
            m.advance(seconds);
            for (const item of Object.keys(economy.materials)) {
              if ((s.allocations[`supply:${item}`] ?? 0n) < m.epoch) {
                m.allocate(`${id}-supply-${item}`, "supply", item);
                m.relistRaw(`${id}-relist-${item}`, item);
              }
            }
            if ((s.allocations["topup:pool"] ?? 0n) < m.epoch)
              m.allocate(`${id}-fund`, "topup");
            note = `Advanced ${seconds} simulated seconds. Applied only the current epoch's bounded supplier/customer allowance; no missed-epoch windfall.`;
            break;
          }
          case "customers": {
            let count = 0;
            for (const product of Object.keys(economy.recipes)) {
              for (let n = 0; n < Number(economy.customerQuota); n++) {
                const listing = s.listings[product];
                if (
                  !listing ||
                  listing.quantity === 0n ||
                  listing.price > BigInt(economy.recipes[product].salePrice) ||
                  s.customer < listing.price ||
                  (s.quota[`${m.epoch}:${product}`] ?? 0n) >=
                    BigInt(economy.customerQuota)
                )
                  break;
                m.sell(`${id}-${product}-${n}`, product);
                count++;
              }
            }
            if (count && this.firstSale === null)
              this.firstSale = {
                wallSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
                simulatedSeconds: s.now,
              };
            note = count
              ? `Deterministic customers bought ${count} products; simulated revenue is now ${s.revenue}.`
              : "No customer sale. Check listed stock, price caps, customer gold and this epoch's per-product quota.";
            break;
          }
          case "upgrade": {
            m.upgrade(id);
            this.upgradeAt = {
              wallSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
              simulatedSeconds: s.now,
            };
            note =
              "Second slot unlocked: burned 150 simulated gold, retained at least 30. Existing jobs keep their timing/output.";
            break;
          }
          default:
            throw Error("Unknown rehearsal action.");
        }
      }
      m.verify();
    } catch (error) {
      m.state = before;
      this.shop = oldShop;
      this.firstSale = oldFirstSale;
      this.upgradeAt = oldUpgrade;
      throw error;
    }
    this.requests.set(id, payload);
    this.log = [
      ...this.log,
      { step: this.requests.size, simulatedSeconds: s.now.toString(), note },
    ].slice(-100);
    return this.snapshot();
  }
}
