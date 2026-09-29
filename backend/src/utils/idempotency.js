const db = require('../db/schema');

const PENDING_RESPONSE = '{"__idempotency_pending":true}';

function getScopedKey(key, userId) {
  return userId == null ? key : `${userId}:${key}`;
}

async function getCachedResponse(key, userId) {
  if (!key) return null;
  const { rows } = await db.query(
    'SELECT response, expires_at FROM idempotency_keys WHERE key = $1',
    [getScopedKey(key, userId)]
  );
  const row = rows[0];
  if (row) {
    if (new Date(row.expires_at) > new Date()) {
      try {
        const response = JSON.parse(row.response);
        return response?.__idempotency_pending === true ? null : response;
      } catch {
        return null;
      }
    }
    await db.query('DELETE FROM idempotency_keys WHERE key = $1', [getScopedKey(key, userId)]);
  }
  return null;
}

async function claimIdempotencyKey(userId, key, ttlSeconds) {
  if (!key || userId == null) throw new Error('A user and idempotency key are required');
  const ttl = ttlSeconds ?? (parseInt(process.env.IDEMPOTENCY_TTL_SECONDS, 10) || 86400);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const scopedKey = getScopedKey(key, userId);
  const { rows } = await db.query(
    `INSERT INTO idempotency_keys (key, response, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at
       WHERE idempotency_keys.expires_at <= $4
     RETURNING key`,
    [scopedKey, PENDING_RESPONSE, expiresAt, now.toISOString()]
  );
  if (rows.length) return { status: 'claimed' };

  const { rows: existingRows } = await db.query(
    'SELECT response, expires_at FROM idempotency_keys WHERE key = $1',
    [scopedKey]
  );
  const existing = existingRows[0];
  if (existing && new Date(existing.expires_at) > now) {
    try {
      const response = JSON.parse(existing.response);
      if (response?.__idempotency_pending !== true) {
        return { status: 'cached', response };
      }
    } catch {
      // Keep an invalid or pending entry locked rather than risk repeating a payment.
    }
  }
  return { status: 'in_progress' };
}

async function releaseIdempotencyKey(key, userId) {
  if (!key || userId == null) return;
  await db.query(
    'DELETE FROM idempotency_keys WHERE key = $1 AND response = $2',
    [getScopedKey(key, userId), PENDING_RESPONSE]
  );
}

async function cacheResponse(key, response, ttlSeconds, userId) {
  if (!key) return;
  const ttl = ttlSeconds ?? (parseInt(process.env.IDEMPOTENCY_TTL_SECONDS, 10) || 86400);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  await db.query(
    'INSERT INTO idempotency_keys (key, response, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at',
    [getScopedKey(key, userId), JSON.stringify(response), expiresAt]
  );
}

module.exports = {
  getCachedResponse,
  claimIdempotencyKey,
  releaseIdempotencyKey,
  cacheResponse,
};
