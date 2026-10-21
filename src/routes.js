const express = require('express');
const { parseCreate, parseUpdate, parseId } = require('./validation');

function transcriptionRoutes(repo) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  router.get('/', wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    res.json(await repo.list({ search, limit, offset }));
  }));

  router.get('/:id', wrap(async (req, res) => {
    const item = await repo.get(parseId(req.params.id));
    if (!item) return res.status(404).json({ error: 'Transcription not found' });
    res.json(item);
  }));

  router.post('/', wrap(async (req, res) => {
    res.status(201).json(await repo.create(parseCreate(req.body)));
  }));

  router.put('/:id', wrap(async (req, res) => {
    const item = await repo.update(parseId(req.params.id), parseUpdate(req.body));
    if (!item) return res.status(404).json({ error: 'Transcription not found' });
    res.json(item);
  }));

  router.delete('/:id', wrap(async (req, res) => {
    const removed = await repo.remove(parseId(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Transcription not found' });
    res.status(204).end();
  }));

  return router;
}

module.exports = { transcriptionRoutes };
