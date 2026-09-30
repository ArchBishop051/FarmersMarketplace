-- Migration: 034_products_category_id
-- Issue #1122: moved out of categories.js module-load DDL into the versioned migrations.

ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id);
