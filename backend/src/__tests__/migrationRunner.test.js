const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations, getPendingFiles } = require('../db/migrationRunner');

describe('migration runner failure recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  const sqlite = new Database(':memory:');
  const db = {
    isPostgres: false,
    placeholder: () => '?',
    exec: async (sql) => sqlite.exec(sql),
    query: async (sql, params = []) => {
      if (/^SELECT/i.test(sql)) return { rows: sqlite.prepare(sql).all(...params) };
      sqlite.prepare(sql).run(...params);
      return { rows: [] };
    },
  };

  afterAll(() => {
    sqlite.close();
    fs.rmSync(dir, { recursive: true });
  });

  it('leaves the failed file pending and resumes after it is fixed', async () => {
    fs.writeFileSync(path.join(dir, '001_first.sql'), 'CREATE TABLE first (id INTEGER);');
    fs.writeFileSync(path.join(dir, '002_broken.sql'), 'BROKEN SQL;');
    fs.writeFileSync(path.join(dir, '003_last.sql'), 'CREATE TABLE last (id INTEGER);');

    await expect(runMigrations(db, dir)).rejects.toThrow();
    const afterFailure = await db.query('SELECT name FROM migrations ORDER BY name');
    expect(afterFailure.rows).toEqual([{ name: '001_first.sql' }]);

    fs.writeFileSync(path.join(dir, '002_broken.sql'), 'CREATE TABLE second (id INTEGER);');
    await runMigrations(db, dir);
    const applied = await db.query('SELECT name FROM migrations ORDER BY name');
    expect(applied.rows.map(({ name }) => name)).toEqual([
      '001_first.sql', '002_broken.sql', '003_last.sql',
    ]);
  });

  it('orders migrations with a shared numeric prefix by full filename', () => {
    const duplicatePrefixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-prefix-migrations-'));
    try {
      fs.writeFileSync(path.join(duplicatePrefixDir, '002_zeta.sql'), '');
      fs.writeFileSync(path.join(duplicatePrefixDir, '002_alpha.sql'), '');

      expect(getPendingFiles(new Set(), duplicatePrefixDir)).toEqual([
        '002_alpha.sql',
        '002_zeta.sql',
      ]);
    } finally {
      fs.rmSync(duplicatePrefixDir, { recursive: true });
    }
  });
});
