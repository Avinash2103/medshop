-- MedShop schema v3: everything a shop needs daily (billing, purchase, returns, accounts).
-- Never edit 001/002; they have already run on installed machines.

-- Bill details typed at the counter (walk-in customers have no customer row).
ALTER TABLE sales ADD COLUMN customer_phone TEXT;
ALTER TABLE sales ADD COLUMN doctor_name TEXT;
ALTER TABLE sales ADD COLUMN cancel_reason TEXT;
ALTER TABLE sales ADD COLUMN cancelled_at TEXT;
CREATE INDEX idx_sales_customer ON sales(customer_id);

ALTER TABLE purchases ADD COLUMN cancel_reason TEXT;
ALTER TABLE purchases ADD COLUMN note TEXT;
CREATE INDEX idx_purchases_date ON purchases(bill_date);
CREATE INDEX idx_purchase_lines_purchase ON purchase_lines(purchase_id);

ALTER TABLE returns ADD COLUMN note TEXT;
ALTER TABLE returns ADD COLUMN refund_mode TEXT;   -- CASH / UPI / CARD / CREDIT (adjusted in account)
CREATE INDEX idx_return_lines_return ON return_lines(return_id);
CREATE INDEX idx_returns_sale ON returns(ref_sale_id);

-- Receipts and payments record how money moved.
ALTER TABLE ledger_entries ADD COLUMN mode TEXT;   -- CASH / UPI / CARD / BANK

-- A sale line can be returned only up to what was sold (checked here, not only in the UI).
CREATE TRIGGER trg_return_lines_limit BEFORE INSERT ON return_lines
WHEN (SELECT type FROM returns WHERE id = NEW.return_id) = 'SALE_RETURN'
 AND NEW.qty_units > (
   SELECT COALESCE(SUM(sl.qty_units), 0) FROM sale_lines sl
   JOIN returns r ON r.id = NEW.return_id
   WHERE sl.sale_id = r.ref_sale_id AND sl.batch_id = NEW.batch_id
 ) - (
   SELECT COALESCE(SUM(rl.qty_units), 0) FROM return_lines rl
   JOIN returns r2 ON r2.id = rl.return_id
   WHERE r2.type = 'SALE_RETURN' AND r2.ref_sale_id = (SELECT ref_sale_id FROM returns WHERE id = NEW.return_id)
     AND rl.batch_id = NEW.batch_id
 )
BEGIN
  SELECT RAISE(ABORT, 'RETURN_MORE_THAN_SOLD');
END;

-- A cancelled bill cannot be cancelled again or returned against.
CREATE TRIGGER trg_sales_cancel_once BEFORE UPDATE OF status ON sales
WHEN OLD.status = 'CANCELLED'
BEGIN
  SELECT RAISE(ABORT, 'ALREADY_CANCELLED');
END;

CREATE TRIGGER trg_purchases_cancel_once BEFORE UPDATE OF status ON purchases
WHEN OLD.status = 'CANCELLED'
BEGIN
  SELECT RAISE(ABORT, 'ALREADY_CANCELLED');
END;

-- Shop profile and bill settings used on printed bills.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('shop_phone', ''),
  ('shop_email', ''),
  ('bill_footer', 'Get well soon. Goods once sold will be taken back only as per rules.'),
  ('paper', '80mm'),
  ('print_after_save', '1'),
  ('backup_dir', ''),
  ('state_code', '');
