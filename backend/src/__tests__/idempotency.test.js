const mockRows = new Map();
jest.unmock('../utils/idempotency');
jest.mock('../db/schema', () => ({ query: jest.fn() }));

async function mockDatabaseQuery(sql, params) {
  const key = params[0];
  if (sql.startsWith('SELECT')) {
    return { rows: mockRows.has(key) ? [mockRows.get(key)] : [] };
  }
  if (sql.startsWith('DELETE')) {
    const row = mockRows.get(key);
    if (!params[1] || row?.response === params[1]) mockRows.delete(key);
    return { rows: [] };
  }
  if (sql.includes('RETURNING key')) {
    const now = new Date(params[3]);
    const existing = mockRows.get(key);
    if (existing && new Date(existing.expires_at) > now) return { rows: [] };
    mockRows.set(key, { response: params[1], expires_at: params[2] });
    return { rows: [{ key }] };
  }
  mockRows.set(key, { response: params[1], expires_at: params[2] });
  return { rows: [] };
}

const {
  getCachedResponse,
  claimIdempotencyKey,
  releaseIdempotencyKey,
  cacheResponse,
} = require('../utils/idempotency');

describe('idempotency cache', () => {
  beforeEach(() => {
    mockRows.clear();
    require('../db/schema').query.mockImplementation(mockDatabaseQuery);
  });

  it('stores and replays the exact response within the owning user scope', async () => {
    const response = { orderId: 7, success: true };
    await cacheResponse('hit', response, 60, 1);
    await expect(getCachedResponse('hit', 1)).resolves.toEqual(response);
    await expect(getCachedResponse('hit', 2)).resolves.toBeNull();
  });

  it('expires entries at their intended TTL', async () => {
    await cacheResponse('old', { success: true }, -1, 1);
    await expect(getCachedResponse('old', 1)).resolves.toBeNull();
    expect(mockRows.has('1:old')).toBe(false);
  });

  it('atomically permits only one in-flight claim for a user and key', async () => {
    const claims = await Promise.all([
      claimIdempotencyKey(1, 'same', 60),
      claimIdempotencyKey(1, 'same', 60),
    ]);
    expect(claims.map(({ status }) => status).sort()).toEqual(['claimed', 'in_progress']);
  });

  it('isolates the same key across users', async () => {
    const first = await claimIdempotencyKey(1, 'same', 60);
    const second = await claimIdempotencyKey(2, 'same', 60);
    expect(first.status).toBe('claimed');
    expect(second.status).toBe('claimed');
  });

  it('releases abandoned claims and replays completed claims', async () => {
    await claimIdempotencyKey(1, 'retry', 60);
    await releaseIdempotencyKey('retry', 1);
    await expect(claimIdempotencyKey(1, 'retry', 60)).resolves.toEqual({ status: 'claimed' });
    await cacheResponse('retry', { orderId: 9 }, 60, 1);
    await expect(claimIdempotencyKey(1, 'retry', 60)).resolves.toEqual({
      status: 'cached',
      response: { orderId: 9 },
    });
  });
});
