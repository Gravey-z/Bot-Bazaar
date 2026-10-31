import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDecision,
  parseDecisionAction,
  decisionSchema,
  DecisionValidationError,
} from "../dist/private/decisions/schema.js";
import { sanitizedDecision } from "../dist/private/storage/validation.js";

const listing = {
  method: "set_listing",
  args: {
    merchant_id: "rex",
    resource: "crystal",
    unit_price: "7",
    quantity: "4",
    active: true,
    expected_version: "1",
    action_id: "1",
  },
};
const proposal = {
  method: "propose_trade",
  args: {
    proposer: "rex",
    buyer: "rex",
    seller: "luna",
    resource: "crystal",
    quantity: "4",
    total_price: "24",
    expires_at_ns: "18446744073709551615",
    action_id: "9007199254740993",
  },
};
const acceptance = {
  method: "accept_trade",
  args: { offer_id: "1", action_id: "1" },
};
const response = (action) => ({
  action,
  reason: "Restore crystal stock while retaining reserves.",
});

for (const action of [
  { method: "hold" },
  { method: "reject_trade", offer_id: "18446744073709551615" },
  listing,
  proposal,
  acceptance,
])
  test(`strict ${action.method} decision round-trips with decimal strings`, () => {
    const value = response(structuredClone(action)),
      parsed = parseDecision(value);
    assert.deepEqual(parsed, value);
    assert.deepEqual(
      JSON.parse(sanitizedDecision(parsed.action, parsed.reason).actionJson),
      action,
    );
    assert.notEqual(parsed, value);
    assert.notEqual(parsed.action, value.action);
    if ("args" in parsed.action)
      assert.notEqual(parsed.action.args, value.action.args);
  });

const invalidActions = [
  null,
  [],
  "hold",
  { method: "send_tx" },
  { method: "cancel_trade", args: { offer_id: "1", action_id: "1" } },
  { method: "expire_offers", args: { offer_ids: ["1"] } },
  { method: "pause_market", args: {} },
  { method: "hold", args: {} },
  { method: "hold", reason: "extra" },
  { method: "reject_trade" },
  { method: "reject_trade", offer_id: "0" },
  { method: "reject_trade", offer_id: "1", args: {} },
  { method: "accept_trade", args: { offer_id: "1" } },
  { method: "accept_trade", args: { ...acceptance.args, quantity: "1" } },
  { ...proposal, args: { ...proposal.args, buyer: "luna", seller: "luna" } },
  { ...proposal, args: { ...proposal.args, proposer: "bolt" } },
  { ...proposal, args: { ...proposal.args, total_price: "25" } },
  { ...proposal, args: { ...proposal.args, total_price: "0" } },
  { ...listing, args: { ...listing.args, active: "true" } },
  { ...listing, args: { ...listing.args, quantity: "0" } },
  { ...listing, args: { ...listing.args, active: false } },
  { ...listing, args: { ...listing.args, resource: "gold" } },
  { ...listing, args: { ...listing.args, merchant_id: "owner" } },
];
test("unknown methods, fields, missing fields and inconsistent structural terms never become a decision", () => {
  for (const action of invalidActions)
    assert.throws(
      () => parseDecision(response(action)),
      DecisionValidationError,
    );
});

for (const invalid of [
  1,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  1n,
  null,
  true,
  "",
  "0",
  "01",
  "+1",
  "-1",
  "1.0",
  "1e2",
  " 1",
  "1 ",
  "1\n",
  "1\r",
  "1\u2028",
  "1\u2029",
  "1\0",
  "１２",
  "0x1",
  "18446744073709551616",
  "9".repeat(1000),
])
  test(`numeric wire value ${String(invalid).slice(0, 25)} is rejected without coercion`, () => {
    for (const action of [
      { method: "reject_trade", offer_id: invalid },
      {
        method: "accept_trade",
        args: { ...acceptance.args, action_id: invalid },
      },
      { ...proposal, args: { ...proposal.args, quantity: invalid } },
      { ...proposal, args: { ...proposal.args, expires_at_ns: invalid } },
      { ...listing, args: { ...listing.args, unit_price: invalid } },
      { ...listing, args: { ...listing.args, expected_version: invalid } },
    ])
      assert.throws(
        () => parseDecision(response(action)),
        DecisionValidationError,
      );
  });

test("contract bounds, deactivation, and exact proposal totals are enforced independently of model guidance", () => {
  for (const action of [
    { ...proposal, args: { ...proposal.args, quantity: "101" } },
    { ...proposal, args: { ...proposal.args, total_price: "10001" } },
    {
      ...proposal,
      args: { ...proposal.args, quantity: "1", total_price: "101" },
    },
    { ...listing, args: { ...listing.args, quantity: "101" } },
    { ...listing, args: { ...listing.args, unit_price: "101" } },
  ])
    assert.throws(
      () => parseDecision(response(action)),
      DecisionValidationError,
    );
  assert.equal(
    parseDecisionAction({
      ...listing,
      args: { ...listing.args, active: false, quantity: "0" },
    }).args.quantity,
    "0",
  );
  assert.equal(
    parseDecisionAction({
      ...proposal,
      args: { ...proposal.args, quantity: "100", total_price: "10000" },
    }).args.total_price,
    "10000",
  );
});

test("the entire response envelope is strict and reasons have a 240 Unicode-character bound", () => {
  for (const value of [
    undefined,
    null,
    [],
    "{invalid",
    "```json\n{}\n```",
    response(null),
    { ...response({ method: "hold" }), tools: [] },
    { action: { method: "hold" } },
    { reason: "wait" },
    { ...response({ method: "hold" }), reason: 7 },
    { ...response({ method: "hold" }), reason: "" },
    { ...response({ method: "hold" }), reason: "😀".repeat(241) },
  ])
    assert.throws(() => parseDecision(value), DecisionValidationError);
  assert.equal(
    parseDecision({ action: { method: "hold" }, reason: "😀".repeat(240) })
      .reason.length,
    480,
  );
});

test("inherited, hidden, symbol and accessor fields cannot bypass exact JSON-object validation", () => {
  let accessed = false;
  const getter = {
    get method() {
      accessed = true;
      return "hold";
    },
  };
  const hidden = { method: "hold" };
  Object.defineProperty(hidden, "apiKey", {
    value: "SECRET",
    enumerable: false,
  });
  const symbol = { method: "hold", [Symbol("secret")]: "SECRET" };
  const inherited = Object.create({ method: "hold" });
  const args = Object.create(listing.args);
  const root = {
    action: { method: "hold" },
    get reason() {
      accessed = true;
      return "SECRET";
    },
  };
  for (const action of [
    getter,
    hidden,
    symbol,
    inherited,
    { ...listing, args },
    JSON.parse('{"method":"hold","__proto__":{"method":"send_tx"}}'),
  ])
    assert.throws(
      () => parseDecision(response(action)),
      DecisionValidationError,
    );
  assert.throws(() => parseDecision(root), DecisionValidationError);
  assert.equal(accessed, false);
  const plain = Object.assign(Object.create(null), { method: "hold" });
  assert.deepEqual(parseDecisionAction(plain), { method: "hold" });
});

test("invalid output errors and persisted decisions never expose attacker extras or known credentials", () => {
  const secret = "NEVER_ECHO_THIS_PRIVATE_TOKEN";
  assert.throws(
    () =>
      parseDecision({ ...response({ method: secret }), privateKey: secret }),
    (error) =>
      error.message === "invalid merchant decision" &&
      !error.message.includes(secret),
  );
  const saved = sanitizedDecision(
    { method: "hold" },
    "wait\nBearer secret sk-test-only",
  );
  assert.equal(saved.reason, "wait [redacted] [redacted]");
});

test("published schema forbids extra fields at every object boundary and exposes exactly five disjoint actions", () => {
  assert.equal(decisionSchema.additionalProperties, false);
  assert.deepEqual(decisionSchema.required, ["action", "reason"]);
  const variants = decisionSchema.properties.action.oneOf;
  assert.deepEqual(
    variants.map((row) => row.properties.method.const),
    ["hold", "reject_trade", "set_listing", "propose_trade", "accept_trade"],
  );
  for (const variant of variants) {
    assert.equal(variant.additionalProperties, false);
    if (variant.properties.args)
      assert.equal(variant.properties.args.additionalProperties, false);
  }
  assert.equal(decisionSchema.properties.reason.maxLength, 240);
  for (const shape of [
    variants[1].properties.offer_id,
    variants[2].properties.args.properties.quantity,
    variants[3].properties.args.properties.total_price,
  ]) {
    assert.equal(new RegExp(shape.pattern).test("1"), true);
    assert.equal(new RegExp(shape.pattern).test("1\n"), false);
  }
});
