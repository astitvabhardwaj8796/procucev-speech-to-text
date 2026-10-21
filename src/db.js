const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transcriptions (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  text        TEXT         NOT NULL,
  language    VARCHAR(32)  NOT NULL DEFAULT 'hi-en',
  source      VARCHAR(32)  NOT NULL DEFAULT 'manual',
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions (created_at DESC);
`;

const COLUMNS = `id, title, text, language, source, duration_ms AS "durationMs",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function createRepository({ connectionString, ssl }) {
  const pool = new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });

  return {
    pool,

    async migrate() {
      await pool.query(SCHEMA);
    },

    async list({ search = '', limit = 20, offset = 0 } = {}) {
      const params = [];
      let where = '';
      if (search) {
        params.push(`%${search}%`);
        where = 'WHERE title ILIKE $1 OR text ILIKE $1';
      }
      const total = await pool.query(`SELECT COUNT(*)::int AS count FROM transcriptions ${where}`, params);
      params.push(limit, offset);
      const rows = await pool.query(
        `SELECT ${COLUMNS} FROM transcriptions ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { items: rows.rows, total: total.rows[0].count };
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM transcriptions WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async create({ title, text, language, source, durationMs }) {
      const { rows } = await pool.query(
        `INSERT INTO transcriptions (title, text, language, source, duration_ms)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [title, text, language, source, durationMs ?? null],
      );
      return rows[0];
    },

    async update(id, { title, text, language }) {
      const { rows } = await pool.query(
        `UPDATE transcriptions SET
           title = COALESCE($2, title),
           text = COALESCE($3, text),
           language = COALESCE($4, language),
           updated_at = NOW()
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, title ?? null, text ?? null, language ?? null],
      );
      return rows[0] || null;
    },

    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM transcriptions WHERE id = $1', [id]);
      return rowCount > 0;
    },

    close() {
      return pool.end();
    },
  };
}

module.exports = { createRepository };
