describe('PostgreSQL database transactions', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let db;
  let client;
  let pool;

  beforeEach(() => {
    jest.resetModules();
    process.env.DATABASE_URL = 'postgres://test-db';

    client = {
      query: jest.fn().mockResolvedValue({ rows: [{ active: 1 }], rowCount: 1 }),
      release: jest.fn(),
    };
    pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };

    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
    jest.doMock('../db/migrationRunner', () => ({
      runMigrations: jest.fn().mockResolvedValue(undefined),
    }));
    jest.unmock('../db/schema');
    db = require('../db/schema');
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    jest.resetModules();
  });

  it('runs every transaction statement on one checked-out client', async () => {
    await db.ready;
    const result = await db.withTransaction(async (tx) => tx.query('SELECT active FROM products'));

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT active FROM products',
      'COMMIT',
    ]);
    expect(result.rows[0].active).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the client when the transaction callback fails', async () => {
    await db.ready;

    await expect(db.withTransaction(async () => {
      throw new Error('order insert failed');
    })).rejects.toThrow('order insert failed');

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
