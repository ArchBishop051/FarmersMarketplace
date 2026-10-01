const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');
const logger = require('../logger');

// Get the best matching tier price for a quantity, or base price if no tiers
async function getTierPrice(productId, quantity) {
  const { rows: tiers } = await db.query(
    'SELECT min_quantity, price_per_unit FROM price_tiers WHERE product_id = $1 ORDER BY min_quantity DESC',
    [productId]
  );

  // Find the highest min_quantity that is <= quantity
  for (const tier of tiers) {
    if (quantity >= tier.min_quantity) {
      logger.debug('[getTierPrice] Matched tier', { productId, quantity, min_quantity: tier.min_quantity, price_per_unit: tier.price_per_unit });
      return tier.price_per_unit;
    }
  }

  // No tier matches, return base price
  const { rows: productRows } = await db.query('SELECT price FROM products WHERE id = $1', [
    productId,
  ]);
  logger.debug('[getTierPrice] No tier matched, using base price', { productId, quantity, base_price: productRows[0].price });
  return productRows[0].price;
}

// Resolve a coupon row and validate it against a farmer + total
// userId is optional; when provided, per-user limit is enforced
async function resolveCoupon(code, farmerId, userId) {
  const { rows: couponRows } = await db.query(
    'SELECT * FROM coupons WHERE code = $1 AND farmer_id = $2',
    [code.toUpperCase(), farmerId]
  );
  const coupon = couponRows[0];
  const coupon = (await db.query('SELECT * FROM coupons WHERE code = $1', [code.toUpperCase()]))
    .rows[0];
  if (!coupon) return { error: 'Invalid coupon code', code: 'invalid_coupon' };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date())
    return { error: 'Coupon has expired', code: 'coupon_expired' };
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses)
    return { error: 'Coupon usage limit reached', code: 'coupon_exhausted' };
  if (userId != null && coupon.max_uses_per_user != null) {
    const { rows: usesRows } = await db.query(
      'SELECT COUNT(*) as cnt FROM coupon_uses WHERE coupon_id = $1 AND user_id = $2',
      [coupon.id, userId]
    );
    if (parseInt(usesRows[0].cnt, 10) >= coupon.max_uses_per_user)
    const uses = (
      await db.query('SELECT COUNT(*) as cnt FROM coupon_uses WHERE coupon_id = $1 AND user_id = $2', [
        coupon.id,
        userId,
      ])
    ).rows[0];
    if (Number(uses.cnt) >= coupon.max_uses_per_user)
      return { error: 'Coupon already used', code: 'coupon_already_used' };
  }
  return { coupon };
}

function calcDiscount(coupon, subtotal) {
  if (coupon.discount_type === 'percent') {
    return Math.min(parseFloat(((subtotal * coupon.discount_value) / 100).toFixed(7)), subtotal);
  }
  return Math.min(coupon.discount_value, subtotal);
}

async function reserveCoupon(couponId, userId) {
  const { rows: userUsageRows } = await db.query(
    `INSERT INTO coupon_user_usage (coupon_id, user_id, used_count)
     SELECT $1, $2, 1
     WHERE EXISTS (
       SELECT 1 FROM coupons
       WHERE id = $3 AND (max_uses_per_user IS NULL OR max_uses_per_user >= 1)
     )
     ON CONFLICT (coupon_id, user_id) DO UPDATE
       SET used_count = coupon_user_usage.used_count + 1
       WHERE EXISTS (
         SELECT 1 FROM coupons
         WHERE id = $4 AND (
           max_uses_per_user IS NULL
           OR coupon_user_usage.used_count < coupons.max_uses_per_user
         )
       )
     RETURNING used_count`,
    [couponId, userId, couponId, couponId]
  );
  if (!userUsageRows.length) return null;

  let rows;
  try {
    ({ rows } = await db.query(
      `UPDATE coupons
       SET used_count = used_count + 1
       WHERE id = $1
         AND (max_uses IS NULL OR used_count < max_uses)
       RETURNING id`,
      [couponId]
    ));
  } catch (error) {
    await decrementUserUsage(couponId, userId);
    throw error;
  }
  if (!rows.length) {
    await decrementUserUsage(couponId, userId);
    return null;
  }

  try {
    const { rows: useRows } = await db.query(
      'INSERT INTO coupon_uses (coupon_id, user_id) VALUES ($1, $2) RETURNING id',
      [couponId, userId]
    );
    return useRows[0].id;
  } catch (error) {
    await db.query(
      'UPDATE coupons SET used_count = used_count - 1 WHERE id = $1 AND used_count > 0',
      [couponId]
    );
    await decrementUserUsage(couponId, userId);
    throw error;
  }
}

async function decrementUserUsage(couponId, userId) {
  await db.query(
    'UPDATE coupon_user_usage SET used_count = used_count - 1 WHERE coupon_id = $1 AND user_id = $2 AND used_count > 0',
    [couponId, userId]
  );
  await db.query(
    'DELETE FROM coupon_user_usage WHERE coupon_id = $1 AND user_id = $2 AND used_count = 0',
    [couponId, userId]
  );
}

async function releaseCoupon(couponId, userId, useId) {
  if (useId == null) return;
  const { rows } = await db.query(
    'DELETE FROM coupon_uses WHERE id = $1 AND coupon_id = $2 AND user_id = $3 RETURNING id',
    [useId, couponId, userId]
  );
  if (rows.length) {
    await db.query(
      'UPDATE coupons SET used_count = used_count - 1 WHERE id = $1 AND used_count > 0',
      [couponId]
    );
    await decrementUserUsage(couponId, userId);
  }
}

// POST /api/coupons — farmer creates a coupon
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'farmer')
    return err(res, 403, 'Only farmers can create coupons', 'forbidden');

  const { code, discount_type, discount_value, max_uses, max_uses_per_user, expires_at } = req.body;
  if (typeof code !== 'string' || !code.trim() || !discount_type || !discount_value)
    return err(
      res,
      400,
      'code, discount_type, and discount_value are required',
      'validation_error'
    );
  if (!['percent', 'fixed'].includes(discount_type))
    return err(res, 400, 'discount_type must be percent or fixed', 'validation_error');
  const value = parseFloat(discount_value);
  if (isNaN(value) || value <= 0)
    return err(res, 400, 'discount_value must be a positive number', 'validation_error');
  if (discount_type === 'percent' && value >= 100)
    return err(res, 400, 'Percent discount must be less than 100', 'validation_error');

  const maxUses = max_uses == null || max_uses === '' ? null : Number(max_uses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1))
    return err(res, 400, 'max_uses must be a positive integer', 'validation_error');

  const maxUsesPerUser =
    max_uses_per_user == null || max_uses_per_user === '' ? null : Number(max_uses_per_user);
  if (maxUsesPerUser !== null && (!Number.isInteger(maxUsesPerUser) || maxUsesPerUser < 1))
    return err(res, 400, 'max_uses_per_user must be a positive integer', 'validation_error');

  let expiresAt = null;
  if (expires_at != null && expires_at !== '') {
    const parsedExpiry = new Date(expires_at);
    if (Number.isNaN(parsedExpiry.getTime()))
      return err(res, 400, 'expires_at must be a valid date', 'validation_error');
    expiresAt = parsedExpiry.toISOString();
  }

  try {
    const normalizedCode = code.trim().toUpperCase();
    const { rows } = await db.query(
      `INSERT INTO coupons
        (farmer_id, code, discount_type, discount_value, max_uses, max_uses_per_user, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [req.user.id, normalizedCode, discount_type, value, maxUses, maxUsesPerUser, expiresAt]
    );
    res.json({ success: true, id: rows[0].id, code: normalizedCode });
  } catch (e) {
    if (e.code === '23505' || e.message.includes('UNIQUE'))
    const { rows } = await db.query(
      'INSERT INTO coupons (farmer_id, code, discount_type, discount_value, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.user.id, code.toUpperCase(), discount_type, value, max_uses || null, expires_at || null]
    );
    res.json({ success: true, id: rows[0].id, code: code.toUpperCase() });
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.code === '23505')
      return err(res, 409, 'Coupon code already exists', 'conflict');
    throw e;
  }
});

// GET /api/coupons — farmer lists their own coupons
router.get('/', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const { rows: coupons } = await db.query(
    'SELECT * FROM coupons WHERE farmer_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ success: true, data: coupons });
});

// DELETE /api/coupons/:id — farmer deletes own coupon
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const { rows } = await db.query(
    'DELETE FROM coupons WHERE id = $1 AND farmer_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return err(res, 404, 'Coupon not found', 'not_found');
  const coupon = (
    await db.query('SELECT * FROM coupons WHERE id = $1 AND farmer_id = $2', [
      req.params.id,
      req.user.id,
    ])
  ).rows[0];
  if (!coupon) return err(res, 404, 'Coupon not found', 'not_found');
  await db.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// POST /api/coupons/validate — buyer checks a coupon for a product
router.post('/validate', auth, async (req, res) => {
  const { code, product_id } = req.body;
  if (!code || !product_id)
    return err(res, 400, 'code and product_id are required', 'validation_error');

  const { rows: prodRows } = await db.query(
    'SELECT id, price, farmer_id FROM products WHERE id = $1',
    [product_id]
  );
  const product = prodRows[0];
  if (!product) return err(res, 404, 'Product not found', 'not_found');

  const quantity = parseInt(req.body.quantity) || 1;
  const unitPrice = await getTierPrice(product_id, quantity);
  const subtotal = unitPrice * quantity;

  const { coupon, error, code: errCode } = await resolveCoupon(code, product.farmer_id, req.user.id);
  if (error) return err(res, errCode === 'coupon_already_used' ? 409 : 400, error, errCode);

  const discount = calcDiscount(coupon, subtotal);
  res.json({
    success: true,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount,
    final_total: parseFloat((subtotal - discount).toFixed(7)),
  });
});

module.exports = router;
module.exports.resolveCoupon = resolveCoupon;
module.exports.calcDiscount = calcDiscount;
module.exports.getTierPrice = getTierPrice;
module.exports.reserveCoupon = reserveCoupon;
module.exports.releaseCoupon = releaseCoupon;
