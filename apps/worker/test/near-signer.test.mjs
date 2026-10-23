import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  KeyPairEd25519,
  SignedTransaction,
} from "near-api-js";

import {
  assertRuntimePermission,
  maximumRuntimeAllowance,
  runtimeMethods,
  signRestrictedTransaction,
} from "../dist/private/near-signer.js";

function fixture(method = "set_listing") {
  const key = KeyPairEd25519.fromRandom();
  const accessKey = {
    nonce: 7n,
    block_height: 1,
    block_hash: baseEncode(new Uint8Array(32).fill(1)),
    permission: {
      FunctionCall: {
        allowance: maximumRuntimeAllowance.toString(),
        receiver_id: "market.testnet",
        method_names: [...runtimeMethods],
      },
    },
  };
  return {
    key,
    networkId: "testnet",
    controllerId: "rex.testnet",
    contractId: "market.testnet",
    secretKey: key.toString(),
    accessKey,
    transaction: createTransaction(
      "rex.testnet",
      key.getPublicKey(),
      "market.testnet",
      8n,
      [
        actions.functionCall(
          method,
          { merchant_id: "rex" },
          30_000_000_000_000n,
          0n,
        ),
      ],
      baseDecode(accessKey.block_hash),
    ),
  };
}

test("SDK signs and serializes each permitted method without broadcasting", async () => {
  for (const method of runtimeMethods) {
    const input = fixture(method);
    const result = await signRestrictedTransaction(input);
    const bytes = result.signedTransaction.encode();
    const restored = SignedTransaction.decode(bytes);
    assert.equal(restored.transaction.receiverId, input.contractId);
    assert.equal(
      restored.transaction.publicKey.toString(),
      input.key.getPublicKey().toString(),
    );
    assert.equal(
      restored.transaction.actions[0].functionCall.methodName,
      method,
    );
    assert.equal(restored.transaction.actions[0].functionCall.deposit, 0n);
    const hash = createHash("sha256")
      .update(restored.transaction.encode())
      .digest();
    assert.deepEqual(new Uint8Array(hash), result.txHash);
    assert.equal(restored.signature.ed25519Signature.data.length, 64);
    assert.ok(
      input.key.verify(
        hash,
        Uint8Array.from(restored.signature.ed25519Signature.data),
      ),
    );
  }
});

test("signing uses a snapshot even if the caller mutates its transaction", async () => {
  const input = fixture();
  const pending = signRestrictedTransaction(input);
  input.transaction.receiverId = "other.testnet";
  input.transaction.actions[0].functionCall.deposit = 1n;
  const result = await pending;
  assert.equal(
    result.signedTransaction.transaction.receiverId,
    "market.testnet",
  );
  assert.equal(
    result.signedTransaction.transaction.actions[0].functionCall.deposit,
    0n,
  );
});

test("SDK represents the finite receiver/method-restricted key for operator provisioning", () => {
  const input = fixture();
  const key = actions.functionCallAccessKey(
    input.contractId,
    [...runtimeMethods],
    maximumRuntimeAllowance,
  );
  assert.equal(key.permission.functionCall.receiverId, input.contractId);
  assert.deepEqual(key.permission.functionCall.methodNames, [
    ...runtimeMethods,
  ]);
  assert.equal(key.permission.functionCall.allowance, maximumRuntimeAllowance);
});

const invalidPermissions = [
  [
    "oversized allowance",
    (permission) => {
      permission.FunctionCall.allowance = "9".repeat(10000);
      return permission;
    },
  ],
  ["full-access", () => "FullAccess"],
  ["missing permission", () => null],
  [
    "wrong receiver",
    (permission) => {
      permission.FunctionCall.receiver_id = "other.testnet";
      return permission;
    },
  ],
  ...[
    null,
    undefined,
    "0",
    "-1",
    "01",
    "1.5",
    (maximumRuntimeAllowance + 1n).toString(),
  ].map((allowance) => [
    "invalid allowance " + allowance,
    (permission) => {
      permission.FunctionCall.allowance = allowance;
      return permission;
    },
  ]),
  [
    "wildcard methods",
    (permission) => {
      permission.FunctionCall.method_names = [];
      return permission;
    },
  ],
  [
    "extra owner method",
    (permission) => {
      permission.FunctionCall.method_names.push("pause");
      return permission;
    },
  ],
  [
    "missing method",
    (permission) => {
      permission.FunctionCall.method_names.pop();
      return permission;
    },
  ],
  [
    "duplicate method",
    (permission) => {
      permission.FunctionCall.method_names[0] = "expire_offers";
      return permission;
    },
  ],
];

for (const [name, change] of invalidPermissions) {
  test(`rejects ${name} permission before signing`, async () => {
    const input = fixture();
    input.accessKey.permission = change(input.accessKey.permission);
    assert.throws(() =>
      assertRuntimePermission(input.accessKey.permission, input.contractId),
    );
    await assert.rejects(signRestrictedTransaction(input));
  });
}

const invalidTransactions = [
  [
    "mainnet",
    (input) => {
      input.networkId = "mainnet";
    },
    /Testnet/,
  ],
  [
    "wrong controller",
    (input) => {
      input.transaction.signerId = "luna.testnet";
    },
    /controller or receiver/,
  ],
  [
    "wrong contract",
    (input) => {
      input.transaction.receiverId = "other.testnet";
    },
    /controller or receiver/,
  ],
  [
    "different key",
    (input) => {
      input.transaction.publicKey = KeyPairEd25519.fromRandom().getPublicKey();
    },
    /public key/,
  ],
  [
    "stale nonce",
    (input) => {
      input.transaction.nonce = 7n;
    },
    /nonce\/block hash/,
  ],
  [
    "different block hash",
    (input) => {
      input.transaction.blockHash = new Uint8Array(32).fill(2);
    },
    /nonce\/block hash/,
  ],
  [
    "owner method",
    (input) => {
      input.transaction.actions[0].functionCall.methodName = "pause";
    },
    /allowlist/,
  ],
  [
    "nonzero deposit",
    (input) => {
      input.transaction.actions[0].functionCall.deposit = 1n;
    },
    /zero NEAR deposit/,
  ],
  [
    "zero gas",
    (input) => {
      input.transaction.actions[0].functionCall.gas = 0n;
    },
    /gas/,
  ],
  [
    "excessive gas",
    (input) => {
      input.transaction.actions[0].functionCall.gas = 300_000_000_000_001n;
    },
    /gas/,
  ],
  [
    "transfer",
    (input) => {
      input.transaction.actions = [actions.transfer(1n)];
    },
    /one function call/,
  ],
  [
    "multiple actions",
    (input) => {
      input.transaction.actions.push(actions.transfer(1n));
    },
    /one function call/,
  ],
  [
    "empty actions",
    (input) => {
      input.transaction.actions = [];
    },
    /one function call/,
  ],
];

for (const [name, change, expectedError] of invalidTransactions) {
  test(`rejects ${name} transaction`, async () => {
    const input = fixture();
    change(input);
    await assert.rejects(signRestrictedTransaction(input), expectedError);
  });
}
