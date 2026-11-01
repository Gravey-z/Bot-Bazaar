export const schemaVersion = 6;

// Only fixed, application-owned column names are passed here.
const u64 = (name: string) => `${name} TEXT CHECK (${name} IS NULL OR
  (length(${name}) BETWEEN 1 AND 20 AND ${name} NOT GLOB '*[^0-9]*'
  AND (${name} = '0' OR substr(${name},1,1) BETWEEN '1' AND '9')
  AND (length(${name}) < 20 OR ${name} <= '18446744073709551615' COLLATE BINARY)))`;

export const schema = `
CREATE TABLE deployment (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL,
  policy_version TEXT NOT NULL, feed_generation TEXT NOT NULL,
  recovery_required INTEGER NOT NULL DEFAULT 1 CHECK(recovery_required IN (0,1)),
  ${u64("observed_revision")}, ${u64("observed_height")}, observed_hash TEXT,
  observed_at INTEGER, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE merchants (
  merchant_id TEXT PRIMARY KEY CHECK(merchant_id IN ('rex','luna','bolt')),
  controller_id TEXT NOT NULL UNIQUE, ${u64("last_action_id")},
  last_action_digest TEXT, shortage_mode INTEGER NOT NULL DEFAULT 1 CHECK(shortage_mode IN (0,1)),
  latest_success TEXT
) STRICT;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, trigger_key TEXT NOT NULL UNIQUE, trigger_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','active','completed','failed','expired')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
  model_attempts INTEGER NOT NULL DEFAULT 0 CHECK(model_attempts>=0)
) STRICT;
CREATE UNIQUE INDEX one_active_job ON jobs((1)) WHERE status='active';
CREATE TRIGGER bound_queue BEFORE INSERT ON jobs WHEN NEW.status='queued'
  AND (SELECT count(*) FROM jobs WHERE status='queued') >= 100
  BEGIN SELECT RAISE(ABORT,'queue full'); END;
CREATE TABLE merchant_locks (
  merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
  kind TEXT NOT NULL CHECK(kind IN ('commitment','controller')),
  job_id TEXT NOT NULL REFERENCES jobs(id), acquired_at INTEGER NOT NULL,
  PRIMARY KEY(merchant_id,kind)
) STRICT;
CREATE TABLE decisions (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
  provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  action_json TEXT NOT NULL CHECK(length(CAST(action_json AS BLOB))<=65536),
  reason TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE intents (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  decision_id TEXT REFERENCES decisions(id), merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
  method TEXT NOT NULL CHECK(method IN ('set_listing','propose_trade','accept_trade','cancel_trade','expire_offers')),
  ${u64("action_id")}, args_json TEXT NOT NULL CHECK(length(CAST(args_json AS BLOB))<=65536),
  args_digest TEXT NOT NULL, ${u64("offer_id")},
  status TEXT NOT NULL CHECK(status IN ('prepared','signed','submitted','unknown','confirmed','failed','abandoned')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX unresolved_controller ON intents(merchant_id)
  WHERE status IN ('prepared','signed','submitted','unknown');
CREATE UNIQUE INDEX protected_action ON intents(merchant_id,action_id)
  WHERE action_id IS NOT NULL AND status IN ('prepared','signed','submitted','unknown','confirmed');
CREATE TABLE attempts (
  intent_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE, tx_hash TEXT NOT NULL UNIQUE,
  ${u64("nonce")}, signed_json TEXT NOT NULL CHECK(length(CAST(signed_json AS BLOB))<=65536),
  evidence_json TEXT CHECK(length(CAST(evidence_json AS BLOB))<=65536), updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE offers (
  ${u64("offer_id")} PRIMARY KEY NOT NULL, job_id TEXT REFERENCES jobs(id),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','cancelled','expired','pruned')),
  ${u64("expires_at_ns")} NOT NULL, cleanup_ack INTEGER NOT NULL CHECK(cleanup_ack IN (0,1)),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER bound_offers BEFORE INSERT ON offers WHEN
  NOT EXISTS(SELECT 1 FROM offers WHERE offer_id=NEW.offer_id)
  AND (SELECT count(*) FROM offers)>=112
  BEGIN SELECT RAISE(ABORT,'offer cache full'); END;
CREATE INDEX terminal_jobs ON jobs(status,updated_at);
CREATE INDEX intents_by_job ON intents(job_id,status);
CREATE INDEX decisions_by_job ON decisions(job_id);
CREATE INDEX offers_by_job ON offers(job_id);
`;

export const discoverySchema = `
CREATE TABLE discovery_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state_json TEXT NOT NULL CHECK(length(CAST(state_json AS BLOB))<=262144)
) STRICT;
CREATE TABLE discovery_signals (
  signal_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('offer_pending','player_purchase','history_gap')),
  merchant_id TEXT CHECK(merchant_id IN ('rex','luna','bolt')),
  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB))<=65536),
  observed_at INTEGER NOT NULL, handled INTEGER NOT NULL DEFAULT 0 CHECK(handled IN (0,1))
) STRICT;
CREATE TRIGGER bound_discovery_signals BEFORE INSERT ON discovery_signals
  WHEN NOT EXISTS(SELECT 1 FROM discovery_signals WHERE signal_key=NEW.signal_key)
  AND (SELECT count(*) FROM discovery_signals)>=256
  BEGIN SELECT RAISE(ABORT,'discovery inbox full'); END;
PRAGMA user_version=2;
`;

export const schedulingSchema = `
CREATE TABLE scheduler_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), completed_seq INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO scheduler_state VALUES(1,0);
CREATE TABLE scheduler_roots (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id), kind TEXT NOT NULL CHECK(kind IN ('purchase','gap','catchup')),
 model_calls INTEGER NOT NULL DEFAULT 0 CHECK(model_calls BETWEEN 0 AND 6),
 mutations INTEGER NOT NULL DEFAULT 0 CHECK(mutations BETWEEN 0 AND 8),
 first_seq INTEGER, last_seq INTEGER, has_gap INTEGER NOT NULL DEFAULT 0 CHECK(has_gap IN (0,1))
) STRICT;
CREATE TABLE scheduler_inputs (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, business_key TEXT NOT NULL UNIQUE,
 fingerprint TEXT NOT NULL, payload_json TEXT, job_id TEXT REFERENCES jobs(id),
 disposition TEXT NOT NULL CHECK(disposition IN ('assigned','quarantined','ignored')),
 observed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE scheduler_sources (
 source_key TEXT PRIMARY KEY, business_key TEXT NOT NULL REFERENCES scheduler_inputs(business_key)
) STRICT;
CREATE TABLE scheduler_turns (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduler_roots(job_id),
 merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
 phase TEXT NOT NULL CHECK(phase IN ('decision','followup')),
 source_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','skipped')),
 UNIQUE(job_id,merchant_id,phase,source_key)
) STRICT;
CREATE UNIQUE INDEX one_running_merchant_turn ON scheduler_turns(merchant_id) WHERE status='running';
CREATE UNIQUE INDEX one_followup_per_merchant ON scheduler_turns(job_id,merchant_id) WHERE phase='followup';
CREATE TABLE scheduler_mutations (
 intent_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES scheduler_turns(id),
 method TEXT NOT NULL, args_json TEXT NOT NULL, merchant_id TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES scheduler_roots(job_id)
) STRICT;
CREATE UNIQUE INDEX one_root_proposal ON scheduler_mutations(job_id,merchant_id) WHERE method='propose_trade';
CREATE UNIQUE INDEX one_root_listing ON scheduler_mutations(job_id,merchant_id) WHERE method='set_listing';
CREATE INDEX scheduler_input_jobs ON scheduler_inputs(job_id,seq);
PRAGMA user_version=3;
`;

export const retrySchema = `
CREATE TABLE retry_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL DEFAULT 0,
 high_water_ms INTEGER NOT NULL DEFAULT 0, clock_blocked INTEGER NOT NULL DEFAULT 0 CHECK(clock_blocked IN (0,1))
) STRICT;
INSERT INTO retry_state(singleton) VALUES(1);
CREATE TABLE provider_attempts (
 id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES scheduler_turns(id),
 job_id TEXT NOT NULL REFERENCES jobs(id), merchant_id TEXT NOT NULL REFERENCES merchants(merchant_id),
 session_id TEXT NOT NULL, epoch INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
 started_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown')),
 reason TEXT, late_ignored INTEGER NOT NULL DEFAULT 0 CHECK(late_ignored IN (0,1)), retry_of TEXT REFERENCES provider_attempts(id)
) STRICT;
CREATE UNIQUE INDEX one_pending_provider_turn ON provider_attempts(turn_id) WHERE status='pending';
CREATE INDEX provider_window ON provider_attempts(started_at);
CREATE INDEX provider_turn_history ON provider_attempts(turn_id,started_at);
PRAGMA user_version=4;
`;

export const policySchema = `
CREATE TABLE usage_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_json TEXT NOT NULL,
 ledger_id TEXT NOT NULL, verified_session TEXT, high_water_ms INTEGER NOT NULL,
 blocked_until INTEGER NOT NULL DEFAULT 0, evidence_ref TEXT
) STRICT;
CREATE TABLE inference_usage (
 request_id TEXT PRIMARY KEY, deployment TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
 started_at INTEGER NOT NULL, reserved_micro INTEGER NOT NULL CHECK(reserved_micro>=1000),
 charged_micro INTEGER NOT NULL CHECK(charged_micro>=0), input_bound INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','accounted')), evidence_ref TEXT
) STRICT;
CREATE INDEX usage_window ON inference_usage(started_at);
CREATE TABLE policy_plans (
 decision_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), merchant_id TEXT NOT NULL,
 steps_json TEXT NOT NULL, slots_remaining INTEGER NOT NULL CHECK(slots_remaining>=0),
 trade_key TEXT, terms_json TEXT, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE policy_steps (
 intent_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES policy_plans(decision_id),
 step_index INTEGER NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('model','prerequisite')),
 reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved IN (0,1))
) STRICT;
CREATE TABLE policy_commitments (
 merchant_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), origin_decision TEXT NOT NULL,
 trade_key TEXT NOT NULL, terms_json TEXT NOT NULL
) STRICT;
CREATE TABLE policy_rejections (
 merchant_id TEXT NOT NULL, offer_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(merchant_id,offer_id)
) STRICT;
ALTER TABLE scheduler_mutations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'model';
DROP INDEX one_root_listing;
CREATE UNIQUE INDEX one_root_listing ON scheduler_mutations(job_id,merchant_id) WHERE method='set_listing' AND purpose='model';
PRAGMA user_version=5;
`;

export const inferenceSchema = `
CREATE TABLE inference_records (
 request_id TEXT PRIMARY KEY REFERENCES provider_attempts(id),
 job_id TEXT NOT NULL REFERENCES jobs(id), merchant_id TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
 actual_provider TEXT, actual_model TEXT,
 payload_sha256 TEXT, input_status TEXT NOT NULL CHECK(input_status IN ('recorded','unavailable','legacy_unavailable')),
 input_json TEXT CHECK(length(CAST(input_json AS BLOB))<=49152),
 returned_action_json TEXT CHECK(length(CAST(returned_action_json AS BLOB))<=65536), reason TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','schema_valid','schema_invalid','failed','unknown','revoked','legacy_unavailable')),
 schema_outcome TEXT NOT NULL CHECK(schema_outcome IN ('pending','valid','invalid','unavailable','legacy_unavailable')),
 policy_outcome TEXT NOT NULL DEFAULT 'not_evaluated' CHECK(policy_outcome IN ('not_evaluated','approved','offchain','rejected','unavailable')),
 outcome_code TEXT, policy_code TEXT,
 prepared_at INTEGER NOT NULL, dispatched_at INTEGER, responded_at INTEGER, finished_at INTEGER,
 policy_at INTEGER, updated_at INTEGER NOT NULL,
 late_ignored INTEGER NOT NULL DEFAULT 0 CHECK(late_ignored IN (0,1))
) STRICT;
CREATE INDEX inference_retention ON inference_records(updated_at);
INSERT INTO inference_records(request_id,job_id,merchant_id,provider,model,prompt_version,input_status,outcome,schema_outcome,prepared_at,updated_at)
 SELECT id,job_id,merchant_id,provider,model,prompt_version,'legacy_unavailable','legacy_unavailable','legacy_unavailable',started_at,started_at FROM provider_attempts;
PRAGMA user_version=6;
`;
