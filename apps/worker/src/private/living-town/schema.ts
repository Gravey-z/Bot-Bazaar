import { townFeedSchema } from "./feed.js";
export const projectionSchema =
  townFeedSchema +
  `
CREATE TABLE projection_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),identity TEXT NOT NULL) STRICT;
CREATE TABLE projection_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=32768)) STRICT;
CREATE TABLE projection_ledgers(actor TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192)) STRICT;
CREATE TABLE projection_shops(shop_id TEXT PRIMARY KEY,owner TEXT NOT NULL UNIQUE REFERENCES projection_ledgers(actor),body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096)) STRICT;
CREATE TABLE production_jobs(job_id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES projection_shops(shop_id),status TEXT NOT NULL CHECK(status IN ('running','completed')),body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096)) STRICT;
CREATE INDEX production_by_shop ON production_jobs(shop_id);
CREATE TABLE production_history(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pruned_through TEXT NOT NULL) STRICT;
CREATE TABLE projection_receipts(tx_hash TEXT PRIMARY KEY,request TEXT NOT NULL,receipt_id TEXT NOT NULL UNIQUE,block_hash TEXT NOT NULL,block_height TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),seen_at INTEGER NOT NULL) STRICT;
CREATE TABLE projection_events(event_sequence TEXT PRIMARY KEY,receipt_id TEXT NOT NULL REFERENCES projection_receipts(receipt_id),log_index TEXT NOT NULL,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=32768),UNIQUE(receipt_id,log_index)) STRICT;
CREATE TRIGGER bounded_receipts BEFORE INSERT ON projection_receipts WHEN (SELECT count(*) FROM projection_receipts)>=10000 BEGIN SELECT RAISE(ABORT,'receipt archive capacity reached'); END;
CREATE TRIGGER bounded_ledgers BEFORE INSERT ON projection_ledgers WHEN NOT EXISTS(SELECT 1 FROM projection_ledgers WHERE actor=NEW.actor) AND (SELECT count(*) FROM projection_ledgers)>=1003 BEGIN SELECT RAISE(ABORT,'ledger capacity reached'); END;
CREATE TRIGGER bounded_shops BEFORE INSERT ON projection_shops WHEN NOT EXISTS(SELECT 1 FROM projection_shops WHERE shop_id=NEW.shop_id) AND (SELECT count(*) FROM projection_shops)>=1003 BEGIN SELECT RAISE(ABORT,'shop capacity reached'); END;
CREATE TABLE market_listings(listing_id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES projection_shops(shop_id),body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096)) STRICT;
CREATE TABLE market_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision TEXT NOT NULL) STRICT;
CREATE TABLE projection_proofs(tx_hash TEXT PRIMARY KEY REFERENCES projection_receipts(tx_hash),body BLOB NOT NULL CHECK(length(body)<=262144)) STRICT;
CREATE TABLE cost_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),through_sequence TEXT NOT NULL) STRICT;
INSERT INTO cost_cursor VALUES(1,'1');
CREATE TABLE cost_actors(actor TEXT PRIMARY KEY) STRICT;
CREATE TABLE cost_inventory(actor TEXT NOT NULL,item TEXT NOT NULL,units BLOB NOT NULL CHECK(length(units)<=32768),PRIMARY KEY(actor,item)) STRICT;
CREATE TABLE cost_jobs(job_id TEXT PRIMARY KEY,actor TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096)) STRICT;
CREATE TABLE cost_job_inputs(job_id TEXT NOT NULL REFERENCES cost_jobs(job_id),item TEXT NOT NULL,units BLOB NOT NULL CHECK(length(units)<=32768),PRIMARY KEY(job_id,item)) STRICT;
CREATE TABLE sales_history(event_sequence TEXT NOT NULL REFERENCES projection_events(event_sequence),actor TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096),PRIMARY KEY(event_sequence,actor)) STRICT;
CREATE INDEX sales_by_actor ON sales_history(actor);
CREATE TABLE customer_fulfillment(actor TEXT NOT NULL,item TEXT NOT NULL,event_sequence TEXT NOT NULL,PRIMARY KEY(actor,item)) STRICT;
PRAGMA user_version=4;
`;
