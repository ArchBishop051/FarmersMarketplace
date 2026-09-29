ALTER TABLE products ADD COLUMN weight_kg REAL;
ALTER TABLE products ADD COLUMN is_preorder BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN preorder_delivery_date DATE;
