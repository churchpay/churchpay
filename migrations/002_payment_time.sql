BEGIN;
ALTER TABLE churchpay_payments ADD COLUMN IF NOT EXISTS paid_at timestamptz;
-- Existing records have no provider timestamp. The earlier creation date is a
-- conservative cutoff; retries and refunds must never restart the 30-day window.
UPDATE churchpay_payments SET paid_at=created_at WHERE capture_id IS NOT NULL AND paid_at IS NULL;
COMMIT;
