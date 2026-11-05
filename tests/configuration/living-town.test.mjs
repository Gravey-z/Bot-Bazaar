import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  livingTownItemIds,
  resourceIds,
  livingTownVersions,
  livingTownFoundationMethods,
} from "../../packages/shared/dist/index.js";
import {
  livingTownItem,
  livingTownSix,
  parseLivingTownU128,
  parseLivingTownInventory,
  parseLivingTownDeployment,
  livingTownSnapshot,
  livingTownFoundation,
  livingTownLimits,
  livingTownTown,
  livingTownPlayer,
  livingTownOwnershipEffect,
  livingTownListing,
  livingTownRawTrade,
  livingTownPurchaseEffect,
  decodeLivingTownSnapshot,
  livingTownJsonDigest,
  canonicalLivingTownJson,
  parseLivingTownJson,
  selectLivingTownDeployment,
} from "../../packages/chain/dist/index.js";
import {
  inventory as legacyInventory,
  resourceId as legacyItem,
} from "../../packages/chain/dist/wire.js";

const config = JSON.parse(
  readFileSync(
    new URL("../../config/living-town-v1.json", import.meta.url),
    "utf8",
  ),
);
const fixture = JSON.parse(
  readFileSync(
    new URL("../scenarios/living-town-economy.json", import.meta.url),
    "utf8",
  ),
);
const genesis = "11111111111111111111111111111111";
const six = (n = "0") =>
  Object.fromEntries(livingTownItemIds.map((item) => [item, n]));
const inventory = () => ({
  held: six(),
  available: six(),
  listing_reserved: six(),
  trade_reserved: six(),
  production_output_reserved: six(),
  trade_inbound_reserved: six(),
});
const deployment = () => ({
  network_id: "testnet",
  genesis_hash: genesis,
  contract_id: "living-town-example.testnet",
  ...livingTownVersions,
  config_sha256: "a".repeat(64),
});
const pub = (
  id = "vaultkeeper-bazaar.testnet",
  worker = "http://127.0.0.1:3001/",
) => ({
  networkId: "testnet",
  contractId: id,
  rpcUrl: "https://test.rpc.fastnear.com/",
  explorerUrl: "https://testnet.nearblocks.io/",
  workerUrl: worker,
});

test("V2 items, exact six-key inventory and u128 values preserve V1 boundaries", () => {
  assert.deepEqual(livingTownItemIds, [
    ...resourceIds,
    "health_potion",
    "iron_tool",
  ]);
  for (const item of livingTownItemIds)
    assert.equal(livingTownItem(item), item);
  assert.throws(() => livingTownItem("gold"));
  assert.throws(() => legacyItem("health_potion"));
  assert.throws(() => legacyInventory(six()));
  assert.throws(() =>
    livingTownSix(String)({ crystal: "0", wood: "0", herb: "0", iron: "0" }),
  );
  const raw = { crystal: "1", wood: "2", herb: "3", iron: "4" };
  assert.deepEqual(legacyInventory(raw), raw);
  assert.equal(
    parseLivingTownU128("340282366920938463463374607431768211455"),
    "340282366920938463463374607431768211455",
  );
  for (const bad of [
    "340282366920938463463374607431768211456",
    1,
    1.5,
    "01",
    "-1",
    "1e3",
    " 1",
    "+1",
    "",
  ])
    assert.throws(() => parseLivingTownU128(bad));
  const valid = inventory();
  valid.held.health_potion = "5";
  valid.available.health_potion = "3";
  valid.listing_reserved.health_potion = "2";
  assert.deepEqual(parseLivingTownInventory(valid), valid);
  for (const mutate of [
    (v) => {
      v.held.health_potion = "6";
    },
    (v) => {
      v.available.health_potion = 3;
    },
    (v) => {
      v.held.health_potion = "1001";
    },
    (v) => {
      v.available.extra = "0";
    },
    (v) => {
      v.production_output_reserved.health_potion = "996";
    },
  ]) {
    const bad = structuredClone(valid);
    mutate(bad);
    assert.throws(() => parseLivingTownInventory(bad));
  }
});

test("V2 raw JSON rejects repeated keys, malformed containers and trailing data before decoding", () => {
  const text = JSON.stringify(inventory());
  assert.deepEqual(
    parseLivingTownInventory(parseLivingTownJson(text)),
    inventory(),
  );
  for (const raw of [
    '{"x":1,"x":2}',
    '{"outer":{"x":1,"\\u0078":2}}',
    '{"a":1,}',
    "[1,]",
    '{"a":"bad\\x"}',
    "{}{}",
    "[",
    '{"a":1e}',
    '{"a":true, "a":false}',
    " ",
  ])
    assert.throws(() => parseLivingTownJson(raw));
  assert.throws(() =>
    parseLivingTownJson("[".repeat(34) + "0" + "]".repeat(34)),
  );
  assert.throws(() => parseLivingTownJson('"' + "x".repeat(262144) + '"'));
  assert.equal(
    parseLivingTownJson(JSON.stringify('escaped"quote')),
    'escaped"quote',
  );
});

test("runtime config is tied to the approved offline economics and exact released limits", async () => {
  const { schema, economyVersion, mode, ...values } = fixture;
  assert.equal(schema, "living-town-economy-fixture-v1");
  assert.equal(mode, "offline_design_model");
  assert.equal(config.version, economyVersion);
  assert.deepEqual(config.economy, values);
  assert.deepEqual(config.items, livingTownItemIds);
  assert.deepEqual(livingTownLimits(config.limits), config.limits);
  assert.match(await livingTownJsonDigest(config), /^[a-f0-9]{64}$/);
  assert.equal(
    await livingTownJsonDigest(parseLivingTownJson(JSON.stringify(config))),
    await livingTownJsonDigest(config),
  );
  const bad = structuredClone(config.limits);
  bad.max_actor_item = "1001";
  assert.throws(() => livingTownLimits(bad));
});

test("V2 command canonical bytes reproduce the cross-language golden domain", async () => {
  const text =
    '{"api_version":"2.0.0","args":{"command":{"config_version":"1","sequence":"2","valid_until_ns":"600000000000"},"name":"Herb Shop"},"contract_id":"living-town-example.testnet","domain":"bot-bazaar:living-town:command:1","genesis_hash":"11111111111111111111111111111111","method":"create_shop","network_id":"testnet","predecessor_account_id":"player-example.testnet","principal":"account:player-example.testnet"}';
  const obj = JSON.parse(text);
  assert.equal(canonicalLivingTownJson(obj), text);
  assert.equal(
    await livingTownJsonDigest(obj),
    "444d932b731adea4360c2381f932c1fecc5c6475ac87ddaa1f3200c389a7cd3f",
  );
  obj.args.command.sequence = "3";
  assert.notEqual(
    await livingTownJsonDigest(obj),
    "444d932b731adea4360c2381f932c1fecc5c6475ac87ddaa1f3200c389a7cd3f",
  );
  assert.throws(() => canonicalLivingTownJson({ quantity: 1 }));
  assert.throws(() => canonicalLivingTownJson({ missing: undefined }));
  assert.throws(() => canonicalLivingTownJson(new Array(2)));
});

test("explicit V2 selection isolates legacy contract/origin/worker and rejects wrong schema/identity", () => {
  const legacy = { public: pub(), origin: "http://127.0.0.1:4200" };
  const input = {
    schema: "bot-bazaar-living-town-selection-v1",
    public: pub("living-town-example.testnet", "http://127.0.0.1:3102/"),
    expected: deployment(),
    code_hash: genesis,
    origin: "http://127.0.0.1:4202",
  };
  const before = structuredClone(legacy);
  const result = selectLivingTownDeployment(input, legacy);
  assert.equal(result.public.contractId, "living-town-example.testnet");
  assert.deepEqual(legacy, before);
  for (const mutate of [
    (i) => {
      i.origin = legacy.origin;
    },
    (i) => {
      i.public.workerUrl = legacy.public.workerUrl;
    },
    (i) => {
      i.public.contractId = legacy.public.contractId;
      i.expected.contract_id = legacy.public.contractId;
    },
    (i) => {
      i.expected.state_schema = "2";
    },
    (i) => {
      i.expected.api_version = "1.0.0";
    },
    (i) => {
      i.expected.config_version = "2";
    },
    (i) => {
      i.expected.config_sha256 = "bad";
    },
    (i) => {
      i.expected.network_id = "mainnet";
    },
    (i) => {
      i.expected.contract_id = "different.testnet";
    },
    (i) => {
      i.expected.genesis_hash = "bad";
    },
    (i) => {
      i.private_key = "no";
    },
  ]) {
    const bad = structuredClone(input);
    mutate(bad);
    assert.throws(() => selectLivingTownDeployment(bad, legacy));
  }
  const copy = deployment();
  assert.deepEqual(parseLivingTownDeployment(copy), copy);
});

test("foundation snapshot and capabilities cannot masquerade as a V1 or truncated V2 view", () => {
  const body = {
    owner_account_id: "owner.testnet",
    operator_account_id: "operator.testnet",
    merchant_controllers: {
      rex: "rex.testnet",
      luna: "luna.testnet",
      bolt: "bolt.testnet",
    },
    item_ids: [...livingTownItemIds],
    supported_methods: [...livingTownFoundationMethods],
  };
  const snapshot = {
    deployment: deployment(),
    market_revision: "1",
    event_sequence: "1",
    block_height: "123",
    block_timestamp_ns: "456",
    data: body,
  };
  const decode = livingTownSnapshot(livingTownFoundation);
  assert.deepEqual(decode(snapshot), snapshot);
  assert.deepEqual(
    decodeLivingTownSnapshot(snapshot, deployment(), livingTownFoundation),
    snapshot,
  );
  for (const [field, value] of [
    ["contract_id", "other.testnet"],
    ["config_sha256", "b".repeat(64)],
    ["genesis_hash", "11111111111111111111111111111112"],
  ]) {
    const wrongIdentity = deployment();
    wrongIdentity[field] = value;
    assert.throws(() =>
      decodeLivingTownSnapshot(snapshot, wrongIdentity, livingTownFoundation),
    );
  }
  const bad = structuredClone(snapshot);
  bad.data.item_ids.pop();
  assert.throws(() => decode(bad));
  const wrong = structuredClone(snapshot);
  wrong.event_sequence = "2";
  assert.throws(() => decode(wrong));
  const overlap = structuredClone(snapshot);
  overlap.data.operator_account_id = overlap.data.owner_account_id;
  assert.throws(() => decode(overlap));
  assert.throws(() =>
    decode({
      market_revision: "1",
      block_height: "1",
      block_timestamp_ns: "1",
      data: {},
    }),
  );
  assert.throws(() => livingTownTown({}));
});

test("ownership views and replay effects bind the player ledger, principal and original grant", () => {
  const player = {
    account_id: "player.testnet",
    ledger: {
      actor: { kind: "player", account_id: "player.testnet" },
      revision: "1",
      gold: {
        held: "100",
        available: "100",
        trade_reserved: "0",
        trade_inbound_reserved: "0",
      },
      inventory: inventory(),
    },
    shop_id: null,
    grant_issued: true,
    grant_command_sequence: "1",
  };
  assert.deepEqual(livingTownPlayer(player), player);
  const effect = {
    principal: "account:player.testnet",
    command_sequence: "1",
    payload_sha256: "a".repeat(64),
    replayed: false,
    effect_revision: "2",
    effect_event_sequence: "2",
    outcome: { kind: "player_registered", player },
  };
  assert.deepEqual(livingTownOwnershipEffect(effect), effect);
  effect.replayed = true;
  assert.equal(livingTownOwnershipEffect(effect).replayed, true);
  for (const mutate of [
    (v) => {
      v.principal = "account:other.testnet";
    },
    (v) => {
      v.outcome.player.ledger.actor.account_id = "other.testnet";
    },
    (v) => {
      v.outcome.player.grant_issued = false;
    },
    (v) => {
      v.command_sequence = "2";
    },
    (v) => {
      v.effect_event_sequence = "3";
    },
    (v) => {
      v.outcome.player.owner_account_id = "other.testnet";
    },
  ]) {
    const bad = structuredClone(effect);
    mutate(bad);
    assert.throws(() => livingTownOwnershipEffect(bad));
  }
});

test("raw purchase effects bind quoted listings, arithmetic, ledgers and command identity", () => {
  const player = { kind: "player", account_id: "buyer.testnet" };
  const seller = { kind: "merchant", merchant_id: "rex" };
  const gold = (held) => ({
    held,
    available: held,
    trade_reserved: "0",
    trade_inbound_reserved: "0",
  });
  const buyerLedger = {
    actor: player,
    revision: "2",
    gold: gold("96"),
    inventory: inventory(),
  };
  buyerLedger.inventory.held.crystal = "1";
  buyerLedger.inventory.available.crystal = "1";
  const sellerLedger = {
    actor: seller,
    revision: "2",
    gold: gold("204"),
    inventory: inventory(),
  };
  sellerLedger.inventory.held.crystal = "9";
  sellerLedger.inventory.available.crystal = "2";
  sellerLedger.inventory.listing_reserved.crystal = "7";
  const trade = {
    trade_id: "1",
    kind: "raw_purchase",
    buyer: player,
    customer_pool_id: null,
    seller,
    item_id: "crystal",
    quantity: "1",
    unit_price: "4",
    total_price: "4",
    listing_id: "1",
    offer_id: null,
    consumed_quantity: "0",
    settled_at_ns: "20",
    command_principal: "account:buyer.testnet",
    command_sequence: "3",
    event_sequence: "4",
  };
  const listing = {
    listing_id: "1",
    shop_id: "1",
    owner: seller,
    item_id: "crystal",
    remaining_quantity: "7",
    unit_price: "4",
    revision: "2",
    active: true,
  };
  const effect = {
    principal: "account:buyer.testnet",
    command_sequence: "3",
    payload_sha256: "a".repeat(64),
    replayed: false,
    effect_revision: "4",
    effect_event_sequence: "4",
    outcome: {
      kind: "raw_purchased",
      trade,
      listing,
      buyer: buyerLedger,
      seller: sellerLedger,
    },
  };
  assert.deepEqual(livingTownPurchaseEffect(effect), effect);
  assert.deepEqual(livingTownRawTrade(trade), trade);
  assert.deepEqual(
    livingTownListing({ ...listing, remaining_quantity: "0", active: false }),
    { ...listing, remaining_quantity: "0", active: false },
  );
  for (const change of [
    (v) => {
      v.principal = "account:thief.testnet";
    },
    (v) => {
      v.command_sequence = "4";
    },
    (v) => {
      v.effect_event_sequence = "5";
    },
    (v) => {
      v.outcome.trade.total_price = "5";
    },
    (v) => {
      v.outcome.trade.quantity = 1;
    },
    (v) => {
      v.outcome.trade.item_id = "health_potion";
    },
    (v) => {
      v.outcome.trade.customer_pool_id = "town_customers";
    },
    (v) => {
      v.outcome.listing.active = false;
    },
    (v) => {
      v.outcome.listing.listing_id = "2";
    },
    (v) => {
      v.outcome.buyer.actor.account_id = "other.testnet";
    },
    (v) => {
      v.outcome.seller.actor.merchant_id = "bolt";
    },
    (v) => {
      v.outcome.seller.inventory.available.crystal = "3";
    },
    (v) => {
      v.outcome.trade.recipient = "thief.testnet";
    },
  ]) {
    const bad = structuredClone(effect);
    change(bad);
    assert.throws(() => livingTownPurchaseEffect(bad));
  }
});
