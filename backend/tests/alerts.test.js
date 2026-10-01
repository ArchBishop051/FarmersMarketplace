const jwt = require('jsonwebtoken');
const { request, app, mockAll, mockQuery } = require('./setup');
const mailer = jest.requireMock('../src/utils/mailer');

beforeEach(() => jest.clearAllMocks());

const SECRET      = process.env.JWT_SECRET || 'secret';
const farmerToken = jwt.sign({ id: 1, role: 'farmer' }, SECRET);
const buyerToken  = jwt.sign({ id: 2, role: 'buyer'  }, SECRET);

// ── Favourites ───────────────────────────────────────────────────────────────

describe('POST /api/alerts/favourites/:productId', () => {
  it('adds a product to favourites', async () => {
    const res = await request(app)
      .post('/api/alerts/favourites/10')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/favourites/i);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/alerts/favourites/10');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/alerts/favourites/:productId', () => {
  it('removes a product from favourites', async () => {
    const res = await request(app)
      .delete('/api/alerts/favourites/10')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/alerts/favourites', () => {
  it('lists user favourites', async () => {
    mockAll.mockReturnValueOnce([{ id: 10, name: 'Tomatoes' }]);
    const res = await request(app)
      .get('/api/alerts/favourites')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });
});

// ── Waitlist ──────────────────────────────────────────────────────────────────

describe('POST /api/alerts/waitlist/:productId', () => {
  it('joins a waitlist', async () => {
    const res = await request(app)
      .post('/api/alerts/waitlist/10')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/waitlist/i);
  });
});

describe('DELETE /api/alerts/waitlist/:productId', () => {
  it('leaves a waitlist', async () => {
    const res = await request(app)
      .delete('/api/alerts/waitlist/10')
      .set('Authorization', `Bearer ${buyerToken}`);
    expect(res.status).toBe(200);
  });
});

// ── Restock notifications ─────────────────────────────────────────────────────

describe('POST /api/products/:id/restock compatibility alias', () => {
  const outOfStockProduct = {
    id: 10, name: 'Tomatoes', quantity: 0, farmer_id: 1,
  };

  function setupRestockMocks(product = outOfStockProduct) {
    mockQuery
      .mockResolvedValueOnce({ rows: [product], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    if (product.quantity === 0) mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  }

  it('returns 403 for buyers', async () => {
    const res = await request(app)
      .post('/api/products/10/restock')
      .set('Authorization', `Bearer ${buyerToken}`)
      .send({ quantity: 5 });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid quantity', async () => {
    const res = await request(app)
      .post('/api/products/10/restock')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ quantity: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown product', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post('/api/products/10/restock')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ quantity: 5 });
    expect(res.status).toBe(404);
  });

  it('uses the same restock workflow as PATCH', async () => {
    setupRestockMocks();

    const res = await request(app)
      .post('/api/products/10/restock')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.waitlist.processed).toBe(0);
    expect(mockQuery.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('SELECT * FROM products'),
        expect.stringContaining('UPDATE products SET quantity'),
        expect.stringContaining('SELECT u.email, u.name FROM stock_alerts'),
      ])
    );
  });

  it('returns the shared waitlist response for an out-of-stock product', async () => {
    setupRestockMocks();

    const res = await request(app)
      .post('/api/products/10/restock')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    expect(res.body.waitlist.processed).toBe(0);
    expect(mailer.sendBackInStockEmail).not.toHaveBeenCalled();
  });

  it('does not send a stock alert email when there are no subscribers', async () => {
    setupRestockMocks();

    const res = await request(app)
      .post('/api/products/10/restock')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.waitlist.processed).toBe(0);

    expect(mailer.sendBackInStockEmail).not.toHaveBeenCalled();
  });

  it('does NOT notify when product was already in stock', async () => {
    const inStock = { ...outOfStockProduct, quantity: 5, restock_notified_at: null };
    setupRestockMocks(inStock);

    const res = await request(app)
      .post('/api/products/10/restock')
      .set('Authorization', `Bearer ${farmerToken}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    await new Promise(r => setImmediate(r));
    expect(mailer.sendBackInStockEmail).not.toHaveBeenCalled();
  });
});
