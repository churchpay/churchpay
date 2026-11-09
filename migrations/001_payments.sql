BEGIN;
CREATE TABLE IF NOT EXISTS churchpay_payments (
  id uuid PRIMARY KEY,
  domain text NOT NULL,
  group_id text NOT NULL,
  person_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 99999999),
  paid_field_id integer NOT NULL CHECK (paid_field_id > 0),
  status text NOT NULL CHECK (status IN ('creating','created','capturing','pending','completed','refunded','reversed','review')),
  order_id text UNIQUE,
  capture_id text UNIQUE,
  capture_requested boolean NOT NULL DEFAULT false,
  synced boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  UNIQUE (domain, group_id, person_id)
);
CREATE INDEX IF NOT EXISTS churchpay_payments_check ON churchpay_payments (checked_at NULLS FIRST);
CREATE TABLE IF NOT EXISTS churchpay_rate_limits (
  key text NOT NULL,
  bucket bigint NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, bucket)
);
COMMIT;
