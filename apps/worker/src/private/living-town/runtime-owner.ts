import { DatabaseSync } from "node:sqlite";
import { existsSync, realpathSync, chmodSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { canonicalLivingTownJson } from "@bot-bazaar/chain";
import { requireStorage, sha256 } from "../storage/validation.js";
import type {
  ContinuityAttestation,
  RecoveryContext,
} from "../recovery/types.js";
import type { LivingTownExecutionStore } from "./execution-store.js";
import type { RuntimeFacts } from "./runtime-facts.js";
import type { RuntimeBudget } from "./runtime-budget.js";

/** Independent, non-restored local witness. Local SQLite locks fence concurrent processes.
 * Host binding forbids ordinary cross-host copies; moving signing hosts needs operator fencing.
 * A journal commit interrupted before its witness commit blocks rather than guessing freshness.
 */
export class RuntimeOwner {
  private readonly db: DatabaseSync;
  private readonly binding: string;
  private stopped = false;
  private providerBinding?: string;
  constructor(
    private readonly store: LivingTownExecutionStore,
    private readonly facts: RuntimeFacts,
    directory: string,
    credentialIds: unknown,
    create: boolean,
    private readonly providerBudget?: RuntimeBudget,
  ) {
    const filename = join(directory, "continuity.sqlite");
    requireStorage(
      create ? !existsSync(filename) : existsSync(filename),
      "explicit independent continuity witness required",
    );
    this.binding = canonicalLivingTownJson({
      host: hostname(),
      path: realpathSync(store.dataDir),
      identity: store.identityHash,
      seed: store.seed,
      credentials: credentialIds,
      // Preserve the v1 witness identity; provider_policy records one-way AI enrollment.
      provider: "disabled",
    });
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    try {
      this.db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      if (create) {
        requireStorage(
          store.unresolved().length === 0 && store.rulesOnlyHistory(),
          "new rules-only witness requires empty economic/provider history",
        );
        this.db.exec(
          "CREATE TABLE witness(singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;",
        );
        this.db
          .prepare("INSERT INTO witness VALUES(1,?,?,0)")
          .run(this.binding, this.digest());
      }
      if (
        this.db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name='provider_policy'",
          )
          .get()
      ) {
        this.providerBinding = String(
          this.db
            .prepare("SELECT binding FROM provider_policy WHERE singleton=1")
            .get()?.["binding"],
        );
      }
      this.verify();
      store.observeMutations(() => this.checkpoint());
      facts.observeMutations(() => this.checkpoint());
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  /** Explicit one-way enrollment, after verifying the original rules-only witness. */
  get providerEnabled(): boolean { return this.providerBinding !== undefined; }
  enableProvider(): void {
    this.verify();
    requireStorage(
      this.providerBudget &&
        !this.providerBinding &&
        this.store.rulesOnlyHistory(),
      "provider enrollment requires verified rules history and shared authority",
    );
    this.providerBudget.verify();
    this.providerBinding = JSON.stringify(this.providerBudget.binding);
    this.db.exec(
      "BEGIN IMMEDIATE; CREATE TABLE provider_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1), binding TEXT NOT NULL) STRICT;",
    );
    this.db
      .prepare("INSERT INTO provider_policy VALUES(1,?)")
      .run(this.providerBinding);
    this.db.exec("COMMIT");
  }
  private verifyProvider(): void {
    if (!this.providerBinding) {
      requireStorage(
        this.store.rulesOnlyHistory(),
        "rules-only provider provenance required",
      );
      return;
    }
    requireStorage(
      this.providerBudget &&
        JSON.stringify(this.providerBudget.binding) === this.providerBinding,
      "original shared provider authority required",
    );
    this.providerBudget.verifyAttempts(this.store.providerHistory());
  }
  private digest(): string {
    return sha256(
      canonicalLivingTownJson({
        execution: this.store.continuityDigest(),
        facts: this.facts.digest(),
      }),
    );
  }
  verify(): void {
    requireStorage(!this.stopped, "runtime witness closed");
    this.verifyProvider();
    const row = this.db.prepare("SELECT * FROM witness").get();
    requireStorage(
      row?.["binding"] === this.binding && row["state"] === this.digest(),
      "journal/witness mismatch or signing host changed; reconcile originals before resuming",
    );
  }
  private checkpoint(): void {
    requireStorage(!this.stopped, "witness unavailable");
    this.verifyProvider();
    this.db
      .prepare(
        "UPDATE witness SET state=?,revision=revision+1 WHERE singleton=1",
      )
      .run(this.digest());
  }
  async attest(
    context: RecoveryContext,
  ): Promise<ContinuityAttestation | undefined> {
    if (
      context.sessionId !== this.store.sessionId ||
      context.identityHash !== this.store.identityHash
    )
      return undefined;
    this.verify();
    return {
      ...context,
      journal: "current",
      fencing: "verified",
      providerHistory: "accounted",
      evidenceRef: `local-witness:${this.digest()}`,
    };
  }
  close(): void {
    if (!this.stopped) {
      this.stopped = true;
      this.db.close();
    }
  }
}
