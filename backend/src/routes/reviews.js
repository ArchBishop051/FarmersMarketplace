const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

// Ensure avg_rating and review_count exist on products
db.query('ALTER TABLE products ADD COLUMN avg_rating REAL DEFAULT 0').catch(() => { /* column may already exist */ });
db.query('ALTER TABLE products ADD COLUMN review_count INTEGER DEFAULT 0').catch(() => { /* column may already exist */ });

async function recalcRating(productId) {
  const { rows } = await db.query(
    `SELECT ROUND(AVG(rating), 2) as avg, COUNT(*) as cnt
    FROM reviews WHERE product_id = $1 AND status = 'approved'`,
    [productId]
  );
  const row = rows[0];
  await db.query('UPDATE products SET avg_rating = $1, review_count = $2 WHERE id = $3', [
    row.avg || 0,
    row.cnt || 0,
    productId,
  ]);
}

// GET /api/reviews/:productId - approved reviews only (public)
router.get('/:productId', async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.rating, r.body, r.created_at, u.name as buyer_name
    FROM reviews r JOIN users u ON r.buyer_id = u.id
    WHERE r.product_id = $1 AND r.status = 'approved'
    ORDER BY r.created_at DESC`,
    [req.params.productId]
  );
  res.json({ success: true, data: rows });
});

// PATCH /api/admin/reviews/:id/approve - admin moderation
router.patch('/admin/reviews/:id/approve', auth, async (req, res) => {
  if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
  const review = (await db.query('SELECT * FROM reviews WHERE id = $1', [req.params.id])).rows[0];
  if (!review) return err(res, 404, 'Review not found', 'not_found');

  await db.query("UPDATE reviews SET status = 'approved' WHERE id = $1", [req.params.id]);
  await recalcRating(review.product_id);
  res.json({ success: true, message: 'Review approved' });
});

// PATCH /api/admin/reviews/:id/reject - admin moderation
router.patch('/admin/reviews/:id/reject', auth, async (req, res) => {
  if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
  const review = (await db.query('SELECT * FROM reviews WHERE id = $1', [req.params.id])).rows[0];
  if (!review) return err(res, 404, 'Review not found', 'not_found');

  await db.query("UPDATE reviews SET status = 'rejected' WHERE id = $1", [req.params.id]);
  await recalcRating(review.product_id);
  res.json({ success: true, message: 'Review rejected' });
});

// GET /api/admin/reviews/pending - list pending reviews for admin
router.get('/admin/reviews/pending', auth, async (req, res) => {
  if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
  const { rows } = await db.query(
    `SELECT r.*, u.name as buyer_name, p.name as product_name
    FROM reviews r
    JOIN users u ON r.buyer_id = u.id
    JOIN products p ON r.product_id = p.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC`
  );
  res.json({ success: true, data: rows });
});

// DELETE /api/reviews/:id - buyer deletes own review
router.delete('/:id', auth, async (req, res) => {
  const review = (
    await db.query('SELECT * FROM reviews WHERE id = $1 AND buyer_id = $2', [req.params.id, req.user.id])
  ).rows[0];
  if (!review) return err(res, 404, 'Review not found or not yours', 'not_found');
  await db.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
  await recalcRating(review.product_id);
  res.json({ success: true, message: 'Review deleted' });
});

const validate = require('../middleware/validate');
const { sanitizeText } = require('../utils/sanitize');

// POST /api/reviews
router.post('/', auth, validate.review, async (req, res) => {
  if (req.user.role !== 'buyer')
    return err(res, 403, 'Only buyers can submit reviews', 'forbidden');

  const product_id = parseInt(req.body.product_id, 10);
  const rating = parseInt(req.body.rating, 10);
  const comment = req.body.comment ? sanitizeText(req.body.comment) : null;

  // Check if buyer has a paid order for this product
  const { rows: orderRows } = await db.query(
    `SELECT id FROM orders WHERE buyer_id = $1 AND product_id = $2 AND status = 'paid' LIMIT 1`,
    [req.user.id, product_id]
  );
  if (!orderRows[0])
    return err(res, 403, 'Purchase required to review this product', 'purchase_required');

  const { rows } = await db.query(
    'INSERT INTO reviews (order_id, buyer_id, product_id, rating, comment) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [orderRows[0].id, req.user.id, product_id, rating, comment]
  );
  res.status(201).json({ success: true, id: rows[0].id, message: 'Review submitted' });
});

// GET /api/products/:id/reviews
router.get('/products/:id/reviews', async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.id, r.rating, r.comment, r.created_at, u.name as reviewer_name
     FROM reviews r JOIN users u ON r.buyer_id = u.id
     WHERE r.product_id = $1 ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json({ success: true, data: rows });
});

module.exports = router;
