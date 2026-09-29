const db = require('../db/schema');
const { reserveCoupon, releaseCoupon } = require('../routes/coupons');

describe('coupon usage reservations', () => {
  beforeEach(() => {
    db.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('reserves both per-user and global quota before a payment', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ used_count: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 22 }], rowCount: 1 });

    await expect(reserveCoupon(10, 2)).resolves.toBe(22);
    expect(db.query.mock.calls[0][0]).toContain('used_count < coupons.max_uses_per_user');
    expect(db.query.mock.calls[1][0]).toContain('used_count < max_uses');
  });

  it('does not reserve when the per-user cap is reached', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(reserveCoupon(10, 2)).resolves.toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('releases per-user reservation when the global cap is reached', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ used_count: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(reserveCoupon(10, 2)).resolves.toBeNull();
    expect(db.query.mock.calls[2][0]).toContain('UPDATE coupon_user_usage');
    expect(db.query.mock.calls[3][0]).toContain('DELETE FROM coupon_user_usage');
  });

  it('returns quota when a pending payment fails', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 22 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await releaseCoupon(10, 2, 22);
    expect(db.query.mock.calls[0][0]).toContain('DELETE FROM coupon_uses');
    expect(db.query.mock.calls[1][0]).toContain('used_count = used_count - 1');
    expect(db.query.mock.calls[2][0]).toContain('UPDATE coupon_user_usage');
    expect(db.query.mock.calls[3][0]).toContain('DELETE FROM coupon_user_usage');
  });
});
