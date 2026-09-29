CREATE TABLE IF NOT EXISTS coupon_user_usage (
  coupon_id  INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
  PRIMARY KEY (coupon_id, user_id)
);

INSERT INTO coupon_user_usage (coupon_id, user_id, used_count)
SELECT coupon_id, user_id, COUNT(*)
FROM coupon_uses
GROUP BY coupon_id, user_id
ON CONFLICT (coupon_id, user_id) DO UPDATE SET used_count = EXCLUDED.used_count;
