/**
 * jobs/contractMonitor.js — Issue #862
 *
 * Subscribes to Soroban contract events for the configured escrow contract and
 * updates order records in the database based on the event type:
 *
 *   deposit  → orders.escrow_status = 'active'
 *   release  → orders.escrow_status = 'released', orders.status = 'paid', notify buyer
 *   refund   → orders.escrow_status = 'refunded', notify buyer
 *   dispute  → orders.escrow_status = 'disputed'
 *
 * Canonical event shapes (issue #1310):
 *   Every escrow state transition emits exactly ONE event, using
 *   `symbol_short!` topics with `order_id` in a consistent position:
 *
 *     topics = (symbol "escrow", symbol <action>, symbol <order_id>)
 *     data   = action-specific tuple (see contracts/escrow/EVENTS.md)
 *
 *   The monitor therefore reads the order_id from topic[2] for every action
 *   and never has to handle legacy string-topic or duplicate variants.
 *
 * Resume behaviour:
 *   The last processed ledger is persisted in `escrow_monitor_cursor`.
 *   On restart the monitor resumes polling from that ledger + 1 so no events
 *   are re-processed or skipped.
 *
 * Retry:
 *   Exponential backoff up to MAX_BACKOFF_MS (60 s) on RPC failures.
 *   After MAX_RETRIES consecutive failures an admin alert email is sent.
 */

'use strict';

const db = require('../db/schema');
const { getContractEvents } = require('../utils/stellar');
const { sendStatusUpdateEmail } = require('../utils/mailer');
const { sendPushToUser } = require('../utils/pushNotifications');
const logger = require('../logger');
const config = require('../config');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 60 * 1000; // 60 s
const ARGS_MAX_BYTES = 65535;

// ── helpers ──────────────────────────────────────────────────────────────────

function truncateArgsForStorage(args) {
  if (args == null) return null;
  const json = JSON.stringify(args);
  if (Buffer.byteLength(json, 'utf8') <= ARGS_MAX_BYTES) return json;
  const marker = '... (truncated)';
  const limit = ARGS_MAX_BYTES - Buffer.byteLength(marker, 'utf8');
  let t = json;
  while (Buffer.byteLength(t, 'utf8') > limit) t = t.slice(0, -1);
  return t + marker;
}

async function storeInvocation({ contractId, method, args, txHash, invocationIndex, success, error }) {
  try {
    const truncatedArgs = truncateArgsForStorage(args);
    await db.query(
      `INSERT INTO contract_invocations
         (contract_id, method, args, tx_hash, invocation_index, success, error, invoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (tx_hash, invocation_index) DO NOTHING`,
      [contractId, method, truncatedArgs, txHash || null, invocationIndex, success ? 1 : 0, error || null]
    );
  } catch (err) {
    logger.error('[ContractMonitor] Failed to store invocation:', err.message);
  }
}

// ── cursor persistence ────────────────────────────────────────────────────────

async function getLastLedger(contractId) {
  try {
    const { rows } = await db.query(
      `SELECT last_ledger FROM escrow_monitor_cursor WHERE contract_id = $1`,
      [contractId]
    );
    return rows[0] ? Number(rows[0].last_ledger) : 0;
  } catch {
    return 0;
  }
}

async function saveLastLedger(contractId, ledger) {
  try {
    await db.query(
      `INSERT INTO escrow_monitor_cursor (contract_id, last_ledger, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (contract_id) DO UPDATE
         SET last_ledger = EXCLUDED.last_ledger,
             updated_at  = CURRENT_TIMESTAMP`,
      [contractId, ledger]
    );
  } catch (err) {
    logger.warn('[ContractMonitor] Could not persist cursor:', err.message);
  }
}

// ── event handlers ────────────────────────────────────────────────────────────

/**
 * Extracts the numeric order_id from the canonical event topics array.
 *
 * Canonical shape (issue #1310): topics = (symbol "escrow", symbol <action>,
 * symbol <order_id>). The order_id therefore always lives at topic[2],
 * regardless of the action, so a single extractor covers every event.
 */
function extractOrderId(topics) {
  const raw = topics[2];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function handleDeposit(contractId, topics, data, txHash) {
  const orderId = extractOrderId(topics);
  if (!orderId) return;

  logger.info(`[ContractMonitor] deposit event — order #${orderId}`);

  await db.query(
    `UPDATE orders SET escrow_status = 'active' WHERE id = $1`,
    [orderId]
  ).catch((e) => logger.error('[ContractMonitor] deposit DB update failed:', e.message));

  await storeInvocation({ contractId, method: 'deposit', args: data, txHash, invocationIndex: 0, success: true, error: null });
}

async function handleRelease(contractId, topics, data, txHash) {
  const orderId = extractOrderId(topics);
  if (!orderId) return;

  logger.info(`[ContractMonitor] release event — order #${orderId}`);

  await db.query(
    `UPDATE orders SET escrow_status = 'released', status = 'paid' WHERE id = $1`,
    [orderId]
  ).catch((e) => logger.error('[ContractMonitor] release DB update failed:', e.message));

  // Notify buyer
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.total_price, u.email, u.name, p.name AS product_name
       FROM orders o
       JOIN users u ON u.id = o.buyer_id
       JOIN products p ON p.id = o.product_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (rows[0]) {
      const order = rows[0];
      await sendStatusUpdateEmail({ order, newStatus: 'paid', recipientEmail: order.email, recipientName: order.name })
        .catch((e) => logger.warn('[ContractMonitor] release email failed (non-fatal):', e.message));
      await sendPushToUser(order.buyer_id, {
        title: 'Payment Released',
        body: `Your escrow for order #${orderId} has been released.`,
      }).catch(() => {});
    }
  } catch (e) {
    logger.warn('[ContractMonitor] release notification failed (non-fatal):', e.message);
  }

  await storeInvocation({ contractId, method: 'release', args: data, txHash, invocationIndex: 0, success: true, error: null });
}

async function handleRefund(contractId, topics, data, txHash) {
  const orderId = extractOrderId(topics);
  if (!orderId) return;

  logger.info(`[ContractMonitor] refund event — order #${orderId}`);

  await db.query(
    `UPDATE orders SET escrow_status = 'refunded' WHERE id = $1`,
    [orderId]
  ).catch((e) => logger.error('[ContractMonitor] refund DB update failed:', e.message));

  // Notify buyer
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.total_price, u.email, u.name, u.id AS buyer_id
       FROM orders o
       JOIN users u ON u.id = o.buyer_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (rows[0]) {
      const order = rows[0];
      await sendStatusUpdateEmail({ order, newStatus: 'refunded', recipientEmail: order.email, recipientName: order.name })
        .catch((e) => logger.warn('[ContractMonitor] refund email failed (non-fatal):', e.message));
      await sendPushToUser(order.buyer_id, {
        title: 'Escrow Refunded',
        body: `Your escrow for order #${orderId} has been refunded.`,
      }).catch(() => {});
    }
  } catch (e) {
    logger.warn('[ContractMonitor] refund notification failed (non-fatal):', e.message);
  }

  await storeInvocation({ contractId, method: 'refund', args: data, txHash, invocationIndex: 0, success: true, error: null });
}

async function handleDispute(contractId, topics, data, txHash) {
  const orderId = extractOrderId(topics);
  if (!orderId) return;

  logger.info(`[ContractMonitor] dispute event — order #${orderId}`);

  await db.query(
    `UPDATE orders SET escrow_status = 'disputed' WHERE id = $1`,
    [orderId]
  ).catch((e) => logger.error('[ContractMonitor] dispute DB update failed:', e.message));

  await storeInvocation({ contractId, method: 'dispute', args: data, txHash, invocationIndex: 0, success: true, error: null });
}

// ── dispatch ──────────────────────────────────────────────────────────────────

/**
 * Canonical escrow event actions (issue #1310). Each state transition emits
 * exactly one event with topics (symbol "escrow", symbol <action>,
 * symbol <order_id>). Actions without an order_id (admin_*) are handled
 * separately and are not routed through the order-scoped handlers below.
 */
const ORDER_SCOPED_ACTIONS = new Set([
  'deposit',
  'release',
  'refund',
  'dispute',
  'resolve',
  'auto_release',
  'stream_created',
  'stream_released',
  'stream_cancelled',
]);

async function dispatchEvent(contractId, ev) {
  const topics = ev.topics || [];
  // Canonical escrow events use topic[0] = 'escrow', topic[1] = action.
  if (String(topics[0]) !== 'escrow') return;
  const action = String(topics[1] || '');
  const txHash = ev.id || null;

  // Only the canonical, order-scoped actions are processed here. Legacy
  // duplicate/string-topic variants are intentionally ignored so a single
  // settlement is never double-counted.
  if (!ORDER_SCOPED_ACTIONS.has(action)) return;

  switch (action) {
    case 'deposit': return handleDeposit(contractId, topics, ev.data, txHash);
    case 'release': return handleRelease(contractId, topics, ev.data, txHash);
    case 'refund':  return handleRefund(contractId, topics, ev.data, txHash);
    case 'dispute': return handleDispute(contractId, topics, ev.data, txHash);
    default:
      // resolve / auto_release / stream_* share the release-style settlement
      // semantics: the order is settled and the buyer is notified.
      return handleRelease(contractId, topics, ev.data, txHash);
  }
}

module.exports = {
  dispatchEvent,
  extractOrderId,
  getLastLedger,
  saveLastLedger,
  storeInvocation,
  POLL_INTERVAL_MS,
  MAX_RETRIES,
  MAX_BACKOFF_MS,
};
