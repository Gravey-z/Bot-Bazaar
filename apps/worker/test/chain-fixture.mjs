import { readFile } from "node:fs/promises";
import { KeyPairEd25519 } from "near-api-js";
import { MarketClient } from "@bot-bazaar/chain";
import { MerchantChainAdapter } from "../dist/private/chain-adapter.js";

export const captured = JSON.parse(
  await readFile(
    new URL("../../../tests/fixtures/chain/market.json", import.meta.url),
    "utf8",
  ),
);
export function proofFor(step) {
  return {
    transactionHash: step.transaction_hash,
    signerId: step.caller,
    publicKey: step.signer_public_key,
    contractId: captured.contract_id,
    nonce: String(step.receipt.transaction.nonce),
    gas: "30000000000000",
    method: step.method,
    args: step.args,
    ...(step.method === "propose_trade"
      ? { merchantId: "rex" }
      : step.method === "accept_trade"
        ? { merchantId: "luna" }
        : {}),
  };
}
export function fixture(options = {}) {
  const state = structuredClone(captured[options.state ?? "seed"]);
  const calls = [],
    loads = [];
  const keypairs = Object.fromEntries(
    ["rex", "luna", "bolt"].map((id) => [id, KeyPairEd25519.fromRandom()]),
  );
  const identity = {
    networkId: "testnet",
    contractId: captured.contract_id,
    ownerId: captured.contract_id,
    codeHash: captured.code_hash,
    controllers: {
      rex: "rex-bazaar.testnet",
      luna: "luna-bazaar.testnet",
      bolt: "bolt-bazaar.testnet",
    },
  };
  const credentials = Object.fromEntries(
    Object.entries(keypairs).map(([id, key]) => [
      id,
      {
        publicKey: key.getPublicKey().toString(),
        loadSecretKey: async () => {
          loads.push(id);
          return key.toString();
        },
      },
    ]),
  );
  async function transport(method, params) {
    calls.push({ method, params: structuredClone(params) });
    let result;
    const block = state.finalized_block;
    if (method === "status")
      result = { chain_id: "testnet", sync_info: { syncing: false } };
    else if (method === "block")
      result = {
        header: {
          hash: block.hash,
          height: block.height,
          timestamp_nanosec: block.timestamp_ns,
        },
      };
    else if (method === "send_tx") result = { final_execution_status: "NONE" };
    else if (method === "tx")
      result = captured.steps.find(
        (row) => row.transaction_hash === params.tx_hash,
      )?.receipt ?? { final_execution_status: "NONE" };
    else if (method === "query") {
      if (params.request_type === "view_account")
        result = state.contract_account;
      else if (params.request_type === "view_access_key") {
        const key = state.keys[params.account_id] ?? {
          ...state.keys["luna-bazaar.testnet"],
        };
        result = { ...key, block_hash: block.hash, block_height: block.height };
      } else if (params.request_type === "call_function") {
        const args = JSON.parse(
          Buffer.from(params.args_base64, "base64").toString("utf8"),
        );
        const market = state.market;
        let view;
        if (params.method_name === "get_market_state") view = market;
        else if (params.method_name === "get_player") view = state.player;
        else if (params.method_name === "get_merchant")
          view = {
            ...market,
            data: market.data.merchants.find(
              (m) => m.merchant_id === args.merchant_id,
            ),
          };
        else if (params.method_name === "get_offer") view = state.offer;
        else {
          const offers = params.method_name === "get_offers_for_merchant";
          let items = offers
            ? state.offer.data.kind === "found"
              ? [state.offer.data.offer]
              : []
            : state.trades.data.items;
          if (offers)
            items = items.filter(
              (row) =>
                [row.buyer, row.seller].includes(args.merchant_id) &&
                (args.status === "all" ||
                  (args.status === "pending"
                    ? row.status === "pending"
                    : row.status !== "pending")),
            );
          const field = offers ? "offer_id" : "trade_id";
          const matching = items.filter(
            (row) =>
              args.after_id === null ||
              BigInt(row[field]) > BigInt(args.after_id),
          );
          const rows = matching.slice(0, Number(args.limit));
          view = {
            ...market,
            data: {
              items: rows,
              next_after_id: rows.at(-1)?.[field] ?? args.after_id,
              has_more: matching.length > rows.length,
              history_gap: false,
              pruned_through: "0",
            },
          };
        }
        result = {
          result: Array.from(Buffer.from(JSON.stringify(view))),
          block_hash: block.hash,
          block_height: block.height,
        };
      } else throw new Error("Unexpected query");
    } else throw new Error("Unexpected method");
    result = structuredClone(result);
    return options.patch ? await options.patch(method, params, result) : result;
  }
  const client = new MarketClient(captured.contract_id, transport);
  const adapter = new MerchantChainAdapter(client, identity, credentials);
  return {
    state,
    identity,
    credentials,
    keypairs,
    calls,
    loads,
    client,
    adapter,
    transport,
  };
}
export function changeView(result, change) {
  const view = JSON.parse(Buffer.from(result.result).toString("utf8"));
  change(view);
  return { ...result, result: Array.from(Buffer.from(JSON.stringify(view))) };
}
