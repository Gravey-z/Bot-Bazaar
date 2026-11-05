// Provider-free economic specification model. This is not a contract emulator,
// signer, durable worker, multi-player scheduler or production command protocol.
import config from "./living-town-economy.json" with { type: "json" };

export const economy = config;
const integer = (value) => {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("invalid integer");
  const result = BigInt(value);
  if (result < 0n) throw new Error("negative integer");
  return result;
};
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const min = (...values) => values.reduce((a, b) => (a < b ? a : b));
const sum = (values) => values.reduce((a, b) => a + b, 0n);
const encode = (value) =>
  JSON.stringify(value, (_, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
export const decimalReport = (value) => JSON.parse(encode(value));

export class EconomyModel {
  constructor({ capacity = config.itemCap } = {}) {
    // A smaller capacity supports explicitly labelled boundary stress cases.
    this.capacity = integer(capacity);
    check(
      this.capacity > 0n && this.capacity <= integer(config.itemCap),
      "invalid stress capacity",
    );
    const items = [
      ...Object.keys(config.materials),
      ...Object.keys(config.recipes),
    ];
    this.state = {
      now: 0n,
      customer: integer(config.customerSeed),
      merchants: Object.fromEntries(
        ["rex", "luna", "bolt"].map((name) => [
          name,
          integer(config.merchantGold),
        ]),
      ),
      player: null,
      stock: Object.fromEntries(
        Object.entries(config.materials).map(([item, row]) => [
          item,
          {
            held: integer(row.seed),
            listed: integer(row.listed),
            price: integer(row.price),
          },
        ]),
      ),
      inventory: Object.fromEntries(items.map((item) => [item, []])),
      outputReserved: Object.fromEntries(items.map((item) => [item, 0n])),
      listings: {},
      jobs: {},
      slots: 1,
      completed: {},
      sold: {},
      quota: {},
      allocations: {},
      commands: {},
      issuedGold:
        3n * integer(config.merchantGold) + integer(config.customerSeed),
      burnedGold: 0n,
      supplied: Object.fromEntries(items.map((item) => [item, 0n])),
      consumed: Object.fromEntries(items.map((item) => [item, 0n])),
      produced: Object.fromEntries(items.map((item) => [item, 0n])),
      purchases: 0n,
      revenue: 0n,
      cogs: 0n,
      upgradeSpending: 0n,
    };
    this.verify();
  }
  get epoch() {
    return this.state.now / integer(config.epochSeconds);
  }
  held(item) {
    return BigInt(this.state.inventory[item].length);
  }
  // Listings reserve the oldest lots. Cancellation/reprice keeps their FIFO order.
  available(item) {
    return this.held(item) - (this.state.listings[item]?.quantity ?? 0n);
  }
  advance(seconds) {
    this.state.now += integer(seconds);
  }
  command(id, method, args, action) {
    const payload = encode({ method, args });
    const old = this.state.commands[id];
    if (old) {
      check(old.payload === payload, "command payload conflict");
      return structuredClone(old.result);
    }
    const before = structuredClone(this.state);
    try {
      const result = action();
      this.verify();
      this.state.commands[id] = { payload, result: structuredClone(result) };
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
  requirePlayer() {
    check(this.state.player !== null, "not registered");
  }
  register(id) {
    return this.command(id, "register", {}, () => {
      check(this.state.player === null, "already registered");
      this.state.player = integer(config.starterGold);
      this.state.issuedGold += this.state.player;
      return this.state.player;
    });
  }
  relistRaw(id, item, price = config.materials[item]?.price) {
    price = integer(price);
    return this.command(id, "relist_raw", { item, price }, () => {
      const row = config.materials[item];
      check(
        row && price >= integer(row.minPrice) && price <= integer(row.maxPrice),
        "raw price band",
      );
      const stock = this.state.stock[item];
      stock.price = price;
      stock.listed = min(
        integer(config.listingCap),
        stock.held - integer(row.floor),
      );
      return stock.listed;
    });
  }
  buy(id, item, quantity) {
    quantity = integer(quantity);
    return this.command(id, "buy", { item, quantity }, () => {
      this.requirePlayer();
      const row = config.materials[item],
        stock = this.state.stock[item];
      check(
        row && quantity > 0n && quantity <= integer(config.quantityCap),
        "purchase quantity",
      );
      const total = quantity * stock.price;
      check(total <= integer(config.totalCap), "purchase total");
      check(
        stock.listed >= quantity && stock.held - quantity >= integer(row.floor),
        "supplier exhausted",
      );
      check(this.state.player >= total, "insufficient gold");
      check(
        this.held(item) + quantity + this.state.outputReserved[item] <=
          this.capacity,
        "output capacity",
      );
      check(
        this.state.merchants[row.supplier] + total <= integer(config.goldCap),
        "merchant gold cap",
      );
      this.state.player -= total;
      this.state.merchants[row.supplier] += total;
      stock.held -= quantity;
      stock.listed -= quantity;
      this.state.inventory[item].push(
        ...Array(Number(quantity)).fill(stock.price),
      );
      this.state.purchases += total;
      return total;
    });
  }
  start(id, product, quantity = 1n) {
    quantity = integer(quantity);
    return this.command(id, "start", { product, quantity }, () => {
      this.requirePlayer();
      const recipe = config.recipes[product];
      check(
        recipe && quantity > 0n && quantity <= integer(config.batchCap),
        "batch quantity",
      );
      check(
        Object.values(this.state.jobs).filter((job) => !job.completed).length <
          this.state.slots,
        "no free slot",
      );
      check(
        this.held(product) + this.state.outputReserved[product] + quantity <=
          this.capacity,
        "output capacity",
      );
      for (const [item, units] of Object.entries(recipe.inputs))
        check(
          this.available(item) >= integer(units) * quantity,
          "insufficient available inputs",
        );
      let cost = 0n;
      for (const [item, units] of Object.entries(recipe.inputs)) {
        const count = integer(units) * quantity;
        cost += sum(this.state.inventory[item].splice(0, Number(count)));
        this.state.consumed[item] += count;
      }
      this.state.outputReserved[product] += quantity;
      this.state.jobs[id] = {
        product,
        quantity,
        cost,
        recipeVersion: config.economyVersion,
        ready: this.state.now + quantity * integer(recipe.seconds),
        completed: false,
      };
      return id;
    });
  }
  complete(id) {
    // Permissionless, rewardless completion is bound to an existing immutable job.
    return this.command(`complete:${id}`, "complete", { id }, () => {
      const job = this.state.jobs[id];
      check(job && this.state.now >= job.ready, "not ready");
      const base = job.cost / job.quantity,
        remainder = job.cost % job.quantity;
      for (let i = 0n; i < job.quantity; i++)
        this.state.inventory[job.product].push(
          base + (i < remainder ? 1n : 0n),
        );
      this.state.outputReserved[job.product] -= job.quantity;
      this.state.produced[job.product] += job.quantity;
      this.state.completed[job.product] = true;
      job.completed = true;
      return job.quantity;
    });
  }
  list(id, product, quantity, price) {
    quantity = integer(quantity);
    price = integer(price);
    return this.command(id, "list", { product, quantity, price }, () => {
      check(config.recipes[product], "only finished products may be listed");
      check(
        quantity <= min(this.held(product), integer(config.listingCap)),
        "listing stock",
      );
      check(price > 0n && price <= integer(config.priceCap), "listing price");
      this.state.listings[product] = { quantity, price };
      return quantity;
    });
  }
  sell(id, product) {
    return this.command(
      id,
      "customer_sale",
      { product, epoch: this.epoch },
      () => {
        const listing = this.state.listings[product];
        check(
          config.recipes[product] && listing?.quantity > 0n,
          "no listed stock",
        );
        check(
          listing.price <= integer(config.recipes[product].salePrice),
          "no demand: overpriced",
        );
        const quotaKey = `${this.epoch}:${product}`;
        check(
          (this.state.quota[quotaKey] ?? 0n) < integer(config.customerQuota),
          "customer quota exhausted",
        );
        check(
          this.state.customer >= listing.price,
          "customer budget exhausted",
        );
        check(
          this.state.player + listing.price <= integer(config.goldCap),
          "player gold cap",
        );
        this.state.customer -= listing.price;
        this.state.player += listing.price;
        listing.quantity--;
        this.state.quota[quotaKey] = (this.state.quota[quotaKey] ?? 0n) + 1n;
        this.state.revenue += listing.price;
        this.state.cogs += this.state.inventory[product].shift();
        this.state.consumed[product]++;
        this.state.sold[product] = true;
        return listing.price;
      },
    );
  }
  allocate(id, kind, item, epoch = this.epoch) {
    epoch = integer(epoch);
    return this.command(id, "allocate", { kind, item, epoch }, () => {
      check(epoch === this.epoch && epoch > 0n, "current epoch only");
      const key = `${kind}:${item ?? "pool"}`;
      check(
        (this.state.allocations[key] ?? 0n) < epoch,
        "epoch already allocated",
      );
      let amount;
      if (kind === "supply") {
        const row = config.materials[item];
        check(row, "invalid supplier item");
        const stock = this.state.stock[item];
        amount = min(
          integer(row.supply),
          integer(row.target) > stock.held
            ? integer(row.target) - stock.held
            : 0n,
        );
        stock.held += amount; // Explicit relisting is a separate operation.
        this.state.supplied[item] += amount;
      } else if (kind === "topup") {
        check(item === undefined, "invalid customer pool");
        amount = min(
          integer(config.customerTopup),
          integer(config.customerCap) - this.state.customer,
        );
        this.state.customer += amount;
        this.state.issuedGold += amount;
      } else {
        check(
          kind === "treasury" && Object.hasOwn(this.state.merchants, item),
          "invalid treasury",
        );
        const gold = this.state.merchants[item];
        amount = min(
          integer(config.treasuryBurnCap),
          gold > integer(config.treasuryRetain)
            ? gold - integer(config.treasuryRetain)
            : 0n,
        );
        this.state.merchants[item] -= amount;
        this.state.burnedGold += amount;
      }
      this.state.allocations[key] = epoch;
      return amount;
    });
  }
  upgrade(id) {
    return this.command(id, "upgrade", {}, () => {
      check(this.state.slots === 1, "already upgraded");
      check(
        Object.keys(config.recipes).every(
          (item) => this.state.completed[item] && this.state.sold[item],
        ),
        "both products required",
      );
      check(
        this.state.player >=
          integer(config.upgradeCost) + integer(config.upgradeReserve),
        "upgrade reserve",
      );
      this.state.player -= integer(config.upgradeCost);
      this.state.burnedGold += integer(config.upgradeCost);
      this.state.upgradeSpending += integer(config.upgradeCost);
      this.state.slots = 2;
      return this.state.player;
    });
  }
  verify() {
    const s = this.state;
    const balances = [
      s.player ?? 0n,
      s.customer,
      ...Object.values(s.merchants),
    ];
    check(
      balances.every((gold) => gold >= 0n && gold <= integer(config.goldCap)),
      "gold bounds",
    );
    check(s.customer <= integer(config.customerCap), "customer cap");
    check(sum(balances) === s.issuedGold - s.burnedGold, "gold conservation");
    for (const [item, lots] of Object.entries(s.inventory)) {
      check(
        lots.every((cost) => cost >= 0n),
        "negative cost",
      );
      check(
        BigInt(lots.length) + s.outputReserved[item] <= this.capacity &&
          s.outputReserved[item] >= 0n,
        "inventory capacity invariant",
      );
      check(this.available(item) >= 0n, "reservation invariant");
      const row = config.materials[item];
      const expected = row
        ? integer(row.seed) + s.supplied[item]
        : s.produced[item];
      check(
        this.held(item) + (s.stock[item]?.held ?? 0n) ===
          expected - s.consumed[item],
        "item conservation",
      );
      if (row)
        check(
          s.stock[item].listed >= 0n &&
            s.stock[item].listed <= s.stock[item].held - integer(row.floor),
          "supplier reservation invariant",
        );
      const reserved = sum(
        Object.values(s.jobs)
          .filter((job) => !job.completed && job.product === item)
          .map((job) => job.quantity),
      );
      check(
        reserved === s.outputReserved[item],
        "job capacity reservation invariant",
      );
    }
    if (s.player !== null) {
      check(
        s.player - integer(config.starterGold) ===
          s.revenue - s.purchases - s.upgradeSpending,
        "cash reconciliation",
      );
      const inventoryCost = sum(Object.values(s.inventory).flat());
      const workCost = sum(
        Object.values(s.jobs)
          .filter((job) => !job.completed)
          .map((job) => job.cost),
      );
      check(
        s.purchases === inventoryCost + workCost + s.cogs,
        "cost conservation",
      );
    }
  }
}
