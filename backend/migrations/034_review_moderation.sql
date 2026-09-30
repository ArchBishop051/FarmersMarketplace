ALTER TABLE reviews
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK(status IN ('pending', 'approved', 'rejected'));

UPDATE reviews SET status = 'approved';
