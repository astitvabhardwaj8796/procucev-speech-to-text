const path = require('path');
const http = require('http');
const express = require('express');
const { transcriptionRoutes } = require('./routes');
const { attachTranscribeSocket } = require('./transcribeSocket');

/**
 * Builds the HTTP + WebSocket server. Dependencies are injected so tests can
 * swap in a fake speech session without calling Gemini.
 */
function createServer({ repo, createSession, geminiModel, finalizeGraceMs = 1500 }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (req, res) => {
    try {
      await repo.pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.get('/api/config', (req, res) => {
    res.json({ geminiEnabled: Boolean(createSession), model: createSession ? geminiModel : null });
  });

  app.use('/api/transcriptions', transcriptionRoutes(repo));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status === 400 || err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = http.createServer(app);
  attachTranscribeSocket(server, { repo, createSession, finalizeGraceMs });
  return server;
}

module.exports = { createServer };
