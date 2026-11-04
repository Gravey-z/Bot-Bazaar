import { createRpcTransport } from "@bot-bazaar/chain";
import type { PublicConfig } from "@bot-bazaar/shared";
import type { WalletManifest } from "@hot-labs/near-connect";
import type { WalletPort } from "./wallet-session";
import type { WalletStorage } from "./wallet-context";
import {
  registrationGas,
  RegistrationNotOpenedError,
} from "./registration-reader";
import { isTestnetAccount } from "./wallet-context";

export const meteorExecutorCommit = "911f9d645b912fadbb1af0d0953cba44b005c82f";
export const meteorManifest: WalletManifest = {
  id: "meteor-wallet",
  name: "Meteor Wallet",
  version: `1.1.1-${meteorExecutorCommit}`,
  description: "Meteor Testnet wallet",
  website: "https://meteorwallet.app/",
  icon: "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/main/assets/meteor-logo-svg.svg",
  executor: `https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/${meteorExecutorCommit}/storage/meteor-near-connect-latest.js`,
  type: "sandbox",
  platform: [],
  features: {
    mainnet: false,
    testnet: true,
    signInWithoutAddKey: true,
    signMessage: true,
    signTransaction: false,
    signAndSendTransaction: true,
    signAndSendTransactions: true,
    signInAndSignMessage: true,
    signInWithFunctionCallKey: false,
    signDelegateActions: false,
  },
  permissions: {
    storage: true,
    external: ["meteorCom", "meteorComV2"],
    allowsOpen: [
      "https://chromewebstore.google.com",
      "https://wallet.meteorwallet.app",
      "https://meteorwallet.app",
      "meteorwallet://",
    ],
  },
};

export async function createWalletPort(
  config: PublicConfig,
  storage: WalletStorage,
): Promise<WalletPort> {
  if (config.networkId !== "testnet") throw new Error("Testnet required");
  const { NearConnector, SandboxWallet } =
    await import("@hot-labs/near-connect");
  const connector = new NearConnector({
    network: "testnet",
    autoConnect: false,
    providers: { testnet: [config.rpcUrl], mainnet: [] },
    features: { testnet: true, signInWithoutAddKey: true },
    manifest: { version: "bot-bazaar-1", wallets: [meteorManifest] },
    footerBranding: null,
    // Ignore connector debug manifests and global wallet preferences.
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
  });
  // Keep a direct reference to our reviewed sandbox adapter. Injected wallets
  // and independently updating manifest entries cannot replace this instance.
  const wallet = new SandboxWallet(connector, structuredClone(meteorManifest));
  const rpc = createRpcTransport(config.rpcUrl);
  const hint = `bot-bazaar:wallet:${config.networkId}:${config.contractId}`;
  async function verifyNetwork(): Promise<void> {
    if (connector.network !== "testnet") throw new Error("Testnet required");
    const status = (await rpc("status", [])) as {
      chain_id?: unknown;
      sync_info?: { syncing?: unknown };
    };
    if (status.chain_id !== "testnet" || status.sync_info?.syncing !== false)
      throw new Error("Testnet unavailable");
  }
  return {
    async accounts() {
      await verifyNetwork();
      return wallet.getAccounts({ network: "testnet" });
    },
    async connect() {
      await verifyNetwork();
      storage.setItem(hint, "meteor-wallet");
      return wallet.signIn({ network: "testnet" });
    },
    async disconnect() {
      storage.removeItem(hint);
      await wallet.signOut({ network: "testnet" });
    },
    async register(accountId) {
      try {
        await verifyNetwork();
        const accounts = await wallet.getAccounts({ network: "testnet" });
        // The pinned Meteor executor uses its stored active identifier rather
        // than the optional signerId argument. Check that public identifier too.
        const active = JSON.parse(
          storage.getItem("meteor-wallet:meteor-account-data") ?? "null",
        ) as {
          account?: { accountId?: string };
          identifier?: {
            accountId?: string;
            network?: string;
            blockchain?: string;
          };
        } | null;
        if (
          !isTestnetAccount(accountId) ||
          !accounts.some((row) => row.accountId === accountId) ||
          active?.account?.accountId !== accountId ||
          active.identifier?.accountId !== accountId ||
          active.identifier.network !== "testnet" ||
          active.identifier.blockchain !== "near"
        )
          throw new Error("Active wallet account changed");
      } catch {
        throw new RegistrationNotOpenedError();
      }
      return wallet.signAndSendTransaction({
        network: "testnet",
        signerId: accountId,
        receiverId: config.contractId,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "register_player",
              args: {},
              gas: registrationGas,
              deposit: "0",
            },
          },
        ],
      });
    },
    subscribe(changed) {
      const signIn = (): void => changed();
      const signOut = (): void => changed();
      connector.on("wallet:signIn", signIn);
      connector.on("wallet:signOut", signOut);
      return () => {
        connector.off("wallet:signIn", signIn);
        connector.off("wallet:signOut", signOut);
      };
    },
  };
}
