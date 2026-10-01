const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { request, app, mockDb } = require('./setup');

describe('#1119 notifyNearbyFarmers filters by radius', () => {
  it('emails only farmers inside the radius that have coordinates', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT, latitude REAL, longitude REAL);
      CREATE TABLE products (id INTEGER PRIMARY KEY, farmer_id INTEGER);
      INSERT INTO users VALUES (1,'owner@x','Owner','farmer',10,10),
        (2,'near@x','Near','farmer',10.1,10.1),
        (3,'far@x','Far','farmer',20,20),
        (4,'nocoords@x','NoCoords','farmer',NULL,NULL);
      INSERT INTO products (farmer_id) VALUES (1),(2),(3),(4);
    `);
    mockDb.query.mockImplementation(async (sql, params = []) => ({
      rows: sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params),
    }));
    const mailer = jest.requireMock('../src/utils/mailer');
    mailer.sendMail = jest.fn().mockResolvedValue();

    const { notifyNearbyFarmers } = require('../src/routes/alerts');
    await notifyNearbyFarmers({
      farmer_id: 1, latitude: 10, longitude: 10, alert_type: 'pest', description: 'd', severity: 'high',
    });

    const recipients = mailer.sendMail.mock.calls.map((c) => c[0].to);
    expect(recipients).toEqual(['near@x']);
  });
});

describe('#1121 bulk upload sanitizes free text', () => {
  it('strips script tags from description', async () => {
    const token = jwt.sign({ id: 1, role: 'farmer' }, process.env.JWT_SECRET || 'secret');
    const run = jest.fn();
    mockDb.prepare.mockReturnValue({ run, get: jest.fn(), all: jest.fn() });
    mockDb.transaction.mockImplementation((fn) => fn);
    const csv = 'name,price,quantity,description\nTomato,1.5,10,"<script>alert(1)</script>Fresh"\n';
    await request(app)
      .post('/api/products/bulk')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(csv), { filename: 'p.csv', contentType: 'text/csv' });
    const args = run.mock.calls[0];
    expect(args[2]).not.toMatch(/<script>/i);
    expect(args[2]).toContain('Fresh');
  });
});

describe('#1120 no db.prepare in migrated routes', () => {
  it.each(['products', 'admin', 'auctions', 'bundles', 'coupons', 'market', 'reviews', 'subscriptions'])(
    '%s.js uses db.query only',
    (name) => {
      const src = fs.readFileSync(path.join(__dirname, '../src/routes', `${name}.js`), 'utf8');
      expect(src).not.toMatch(/db\.(prepare|exec|transaction)\(/);
    }
  );
});
