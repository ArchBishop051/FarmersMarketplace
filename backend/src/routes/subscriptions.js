const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

const FREQUENCIES = ['weekly', 'biweekly', 'monthly'];

function nextOrderDate(frequency) {
  const d = new Date();
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// POST /api/subscriptions — buyer creates a subscription
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'buyer') return err(res, 403, 'Only buyers can subscribe', 'forbidden');

  const { product_id, frequency } = req.body;
  const quantity = parseInt(req.body.quantity, 10);

  if (!product_id) return err(res, 400, 'product_id is required', 'validation_error');
  if (!FREQUENCIES.includes(frequency))
    return err(res, 400, `frequency must be one of: ${FREQUENCIES.join(', ')}`, 'validation_error');
  if (isNaN(quantity) || quantity < 1)
    return err(res, 400, 'quantity must be a positive integer', 'validation_error');

  const product = (await db.query('SELECT id FROM products WHERE id = $1', [product_id])).rows[0];
  if (!product) return err(res, 404, 'Product not found', 'not_found');

  const { rows } = await db.query(
    'INSERT INTO subscriptions (buyer_id, product_id, quantity, frequency, next_order_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.user.id, product_id, quantity, frequency, nextOrderDate(frequency)]
  );

  res.status(201).json({ success: true, id: rows[0].id });
});

// GET /api/subscriptions — buyer's subscriptions
router.get('/', auth, async (req, res) => {
  if (req.user.role !== 'buyer') return err(res, 403, 'Buyers only', 'forbidden');

  const { rows: data } = await db.query(
    `SELECT s.*, p.name as product_name, p.price as product_price, p.unit
    FROM subscriptions s JOIN products p ON s.product_id = p.id
    WHERE s.buyer_id = $1 AND s.status != 'cancelled'
    ORDER BY s.created_at DESC`,
    [req.user.id]
  );

  res.json({ success: true, data });
});

// PATCH /api/subscriptions/:id/pause — buyer pauses
router.patch('/:id/pause', auth, async (req, res) => {
  const sub = (
    await db.query('SELECT * FROM subscriptions WHERE id = $1 AND buyer_id = $2', [
      req.params.id,
      req.user.id,
    ])
  ).rows[0];
  if (!sub) return err(res, 404, 'Subscription not found', 'not_found');
  if (sub.status === 'cancelled')
    return err(res, 400, 'Cannot pause a cancelled subscription', 'invalid_state');
  await db.query("UPDATE subscriptions SET status = 'paused', active = 0 WHERE id = $1", [sub.id]);
  res.json({ success: true });
});

// PATCH /api/subscriptions/:id/resume — buyer resumes
router.patch('/:id/resume', auth, async (req, res) => {
  const sub = (
    await db.query('SELECT * FROM subscriptions WHERE id = $1 AND buyer_id = $2', [
      req.params.id,
      req.user.id,
    ])
  ).rows[0];
  if (!sub) return err(res, 404, 'Subscription not found', 'not_found');
  if (sub.status === 'cancelled')
    return err(res, 400, 'Cannot resume a cancelled subscription', 'invalid_state');
  await db.query(
    "UPDATE subscriptions SET status = 'active', active = 1, next_order_at = $1 WHERE id = $2",
    [nextOrderDate(sub.frequency), sub.id]
  );
  res.json({ success: true });
});

// DELETE /api/subscriptions/:id — buyer cancels
router.delete('/:id', auth, async (req, res) => {
  const sub = (
    await db.query('SELECT * FROM subscriptions WHERE id = $1 AND buyer_id = $2', [
      req.params.id,
      req.user.id,
    ])
  ).rows[0];
  if (!sub) return err(res, 404, 'Subscription not found', 'not_found');
  await db.query("UPDATE subscriptions SET status = 'cancelled', active = 0 WHERE id = $1", [sub.id]);
  res.json({ success: true });
});

module.exports = { router, nextOrderDate };
