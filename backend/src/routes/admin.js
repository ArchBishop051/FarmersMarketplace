const router = require('express').Router();
const db = require('../db/schema');
const adminAuth = require('../middleware/adminAuth');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { sendPayment } = require('../utils/stellar');

// GET /api/admin/returns - list all return requests
router.get('/returns', adminAuth, async (req, res) => {
  const { rows: returns } = await db.query(`
    SELECT r.*, o.total_price, o.shipping_cost, o.stellar_tx_hash AS order_tx_hash,
           p.name AS product_name,
           b.name AS buyer_name, b.email AS buyer_email
    FROM returns r
    JOIN orders o ON r.order_id = o.id
    JOIN products p ON o.product_id = p.id
    JOIN users b ON r.buyer_id = b.id
    ORDER BY r.created_at DESC
  `);
  res.json(returns);
});

// POST /api/admin/returns/:id/approve
router.post('/returns/:id/approve', adminAuth, async (req, res) => {
  const ret = (await db.query(`
    SELECT r.*,
           o.total_price, o.shipping_cost,
           b.stellar_public_key AS buyer_wallet,
           f.stellar_secret_key AS farmer_secret
    FROM returns r
    JOIN orders o ON r.order_id = o.id
    JOIN users b ON r.buyer_id = b.id
    JOIN products p ON o.product_id = p.id
    JOIN users f ON p.farmer_id = f.id
    WHERE r.id = $1
  `, [req.params.id])).rows[0];

  if (!ret) return res.status(404).json({ error: 'Return request not found' });
  if (ret.status !== 'pending') return res.status(400).json({ error: `Return already ${ret.status}` });

  const refundAmount = ret.total_price + (ret.shipping_cost || 0);

  try {
    const txHash = await sendPayment({
      senderSecret: ret.farmer_secret,
      receiverPublicKey: ret.buyer_wallet,
      amount: refundAmount,
      memo: `Refund#${ret.id}`,
    });

    await db.query('UPDATE returns SET status = $1, refund_tx_hash = $2 WHERE id = $3', [
      'approved',
      txHash,
      ret.id,
    ]);

    res.json({ message: 'Return approved and refund issued', refundAmount, txHash });
  } catch (err) {
    res.status(500).json({ error: 'Refund transaction failed: ' + err.message });
  }
});

// POST /api/admin/returns/:id/reject
router.post('/returns/:id/reject', adminAuth, async (req, res) => {
  const ret = (await db.query('SELECT * FROM returns WHERE id = $1', [req.params.id])).rows[0];
  if (!ret) return res.status(404).json({ error: 'Return request not found' });
  if (ret.status !== 'pending') return res.status(400).json({ error: `Return already ${ret.status}` });

  await db.query('UPDATE returns SET status = $1 WHERE id = $2', ['rejected', ret.id]);
  res.json({ message: 'Return request rejected' });
});

// GET /api/admin/users - list users with pagination and filters
router.get('/users', adminAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (req.query.active !== undefined) {
    const activeValue = req.query.active === '1' || req.query.active === 'true';
    params.push(activeValue);
    conditions.push(`active = $${params.length}`);
  }
  if (req.query.role !== undefined) {
    params.push(req.query.role);
    conditions.push(`role = $${params.length}`);
  }
  if (req.query.verified !== undefined) {
    if (req.query.verified === 'true' || req.query.verified === '1') {
      conditions.push('email_verified_at IS NOT NULL');
    } else {
      conditions.push('email_verified_at IS NULL');
    }
  }
  if (req.query.banned !== undefined) {
    if (req.query.banned === 'true' || req.query.banned === '1') {
      conditions.push('banned_at IS NOT NULL');
    } else {
      conditions.push('banned_at IS NULL');
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query(`SELECT COUNT(*) as count FROM users ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);
  const pages = Math.ceil(total / limit);

  params.push(limit);
  params.push(offset);
  const users = await db.query(
    `SELECT id, name, email, role, created_at, active, banned_at, email_verified_at
     FROM users
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({
    data: users.rows,
    pagination: { page, limit, total, pages },
  });
});

// GET /api/admin/orders - list orders with pagination
router.get('/orders', adminAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
  
  const offset = (page - 1) * limit;
  
  // Get total count
  const countResult = (await db.query('SELECT COUNT(*) as count FROM orders')).rows[0];
  const total = Number(countResult.count);
  const pages = Math.ceil(total / limit);
  
  // Get paginated data
  const { rows: orders } = await db.query(`
    SELECT 
      o.id, 
      o.buyer_id, 
      b.name AS buyer_name,
      o.product_id,
      p.name AS product_name,
      o.quantity,
      o.total_price,
      o.status,
      o.created_at
    FROM orders o
    JOIN users b ON o.buyer_id = b.id
    JOIN products p ON o.product_id = p.id
    ORDER BY o.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  
  res.json({
    data: orders,
    pagination: {
      page,
      limit,
      total,
      pages
    }
  });
});

// DELETE /api/admin/users/:id - deactivate user
router.delete('/users/:id', adminAuth, async (req, res) => {
  const userId = req.params.id;
  
  const user = (await db.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  await db.query('UPDATE users SET active = 0 WHERE id = $1', [userId]);
  
  res.json({ message: 'User deactivated successfully' });
});

// GET /api/admin/stats - dashboard statistics
router.get('/stats', adminAuth, async (req, res) => {
  const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].count);
  const totalUsers = await count('SELECT COUNT(*) as count FROM users');
  const totalProducts = await count('SELECT COUNT(*) as count FROM products');
  const totalOrders = await count('SELECT COUNT(*) as count FROM orders');
  const totalRevenue = (
    await db.query("SELECT COALESCE(SUM(total_price), 0) as total FROM orders WHERE status = $1", ['paid'])
  ).rows[0].total;
  
  res.json({
    totalUsers,
    totalProducts,
    totalOrders,
    totalRevenue
  });
});

// GET /api/admin/analytics/summary - last-30-day platform metrics
router.get('/analytics/summary', adminAuth, async (req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const gmv = (await db.query(`
    SELECT
      ROUND(SUM(total_price), 7)                                             AS total,
      ROUND(SUM(total_price - COALESCE(shipping_cost, 0)), 7)                AS product,
      ROUND(SUM(COALESCE(shipping_cost, 0)), 7)                              AS shipping,
      COUNT(*)                                                                AS paid_orders
    FROM orders
    WHERE status = 'paid'
      AND created_at >= $1
  `, [since])).rows[0];

  const conversion = (await db.query(`
    SELECT
      COUNT(*)                                                                              AS total_orders,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END)                                    AS paid_orders,
      ROUND(100.0 * SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) / COUNT(*), 2)       AS rate_pct
    FROM orders
    WHERE created_at >= $1
  `, [since])).rows[0];

  const { rows: topProducts } = await db.query(`
    SELECT p.id, p.name, u.name AS farmer_name,
           SUM(o.quantity)                                                   AS units_sold,
           ROUND(SUM(o.total_price - COALESCE(o.shipping_cost, 0)), 7)      AS revenue
    FROM orders o
    JOIN products p ON o.product_id = p.id
    JOIN users u ON p.farmer_id = u.id
    WHERE o.status = 'paid'
      AND o.created_at >= $1
    GROUP BY p.id, p.name, u.name
    ORDER BY revenue DESC
    LIMIT 5
  `, [since]);

  // Daily active users: distinct buyers + farmers touched by orders each day
  const { rows: dailyActiveUsers } = await db.query(`
    SELECT day, COUNT(DISTINCT user_id) AS active_users
    FROM (
      SELECT CAST(o.created_at AS DATE) AS day, o.buyer_id AS user_id
      FROM orders o
      WHERE o.created_at >= $1
      UNION ALL
      SELECT CAST(o.created_at AS DATE) AS day, p.farmer_id AS user_id
      FROM orders o
      JOIN products p ON o.product_id = p.id
      WHERE o.created_at >= $1
    ) t
    GROUP BY day
    ORDER BY day ASC
  `, [since]);

  const { rows: dailyGmv } = await db.query(`
    SELECT CAST(created_at AS DATE) AS day, ROUND(SUM(total_price), 7) AS gmv, COUNT(*) AS orders
    FROM orders
    WHERE status = 'paid'
      AND created_at >= $1
    GROUP BY CAST(created_at AS DATE)
    ORDER BY day ASC
  `, [since]);

  res.json({
    period: 'last_30_days',
    gmv,
    conversion: conversion.total_orders ? conversion : { total_orders: 0, paid_orders: 0, rate_pct: 0 },
    top_products: topProducts,
    daily_active_users: dailyActiveUsers,
    daily_gmv: dailyGmv,
  });
});

// GET /api/admin/failed-emails
router.get('/failed-emails', adminAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM failed_emails ORDER BY created_at DESC');
  res.json({ success: true, data: rows });
});

// GET /api/admin/analytics/creator-earnings — Issue #998
// Platform-wide Creator Earnings totals + a daily time-series breakdown,
// aggregated from the creator_earnings_ledger table populated by
// jobs/creatorEarningsMonitor.js.
router.get('/analytics/creator-earnings', auth, requireAdmin, async (req, res) => {
  const { rows: totalsRows } = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type = 'credit' THEN amount ELSE 0 END), 0) AS total_credited,
       COALESCE(SUM(CASE WHEN event_type = 'claim'  THEN amount ELSE 0 END), 0) AS total_claimed,
       COALESCE(SUM(CASE WHEN event_type = 'credit' THEN fee_amount ELSE 0 END), 0) AS total_platform_fee
     FROM creator_earnings_ledger`
  );

  const dayExpr = db.isPostgres ? `TO_CHAR(created_at, 'YYYY-MM-DD')` : `date(created_at)`;
  const { rows: seriesRows } = await db.query(
    `SELECT ${dayExpr} AS day,
            event_type,
            COALESCE(SUM(amount), 0) AS amount,
            COALESCE(SUM(fee_amount), 0) AS fee_amount
     FROM creator_earnings_ledger
     GROUP BY ${dayExpr}, event_type
     ORDER BY day ASC`
  );

  const byDay = new Map();
  for (const row of seriesRows) {
    if (!byDay.has(row.day)) {
      byDay.set(row.day, { day: row.day, credited: 0, claimed: 0, platform_fee: 0 });
    }
    const bucket = byDay.get(row.day);
    if (row.event_type === 'credit') {
      bucket.credited += Number(row.amount);
      bucket.platform_fee += Number(row.fee_amount);
    } else if (row.event_type === 'claim') {
      bucket.claimed += Number(row.amount);
    }
  }

  res.json({
    success: true,
    data: {
      total_credited_xlm: Number(totalsRows[0].total_credited),
      total_claimed_xlm: Number(totalsRows[0].total_claimed),
      total_platform_fee_xlm: Number(totalsRows[0].total_platform_fee),
      time_series: [...byDay.values()],
    },
  });
});

module.exports = router;
