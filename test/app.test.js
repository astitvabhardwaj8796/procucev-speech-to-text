// Integration tests. Requires a PostgreSQL database:
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/speech_to_text_test npm test
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const WebSocket = require('ws');
const { createRepository } = require('../src/db');
const { createServer } = require('../src/app');

const connectionString = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/speech_to_text_test';

let repo;
let server;
let baseUrl;
let fakeSessions = [];

// Stands in for Gemini Live: echoes a canned transcript as audio arrives.
function fakeCreateSession({ onTranscript }) {
  const session = {
    audioBytes: 0,
    ended: false,
    closed: false,
    words: ['Kal ', 'meeting ', 'दस बजे ', 'hai'],
    sendAudio(buf) {
      this.audioBytes += buf.length;
      const word = this.words.shift();
      if (word) onTranscript(word);
    },
    endAudio() { this.ended = true; },
    close() { this.closed = true; },
  };
  fakeSessions.push(session);
  return Promise.resolve(session);
}

before(async () => {
  repo = createRepository({ connectionString });
  await repo.migrate();
  server = createServer({ repo, createSession: fakeCreateSession, geminiModel: 'fake-live', finalizeGraceMs: 50 });
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await repo.close();
});

beforeEach(async () => {
  fakeSessions = [];
  await repo.pool.query('TRUNCATE transcriptions RESTART IDENTITY');
});

test('health and config endpoints', async () => {
  const health = await request(server).get('/api/health').expect(200);
  assert.equal(health.body.database, 'up');
  const config = await request(server).get('/api/config').expect(200);
  assert.deepEqual(config.body, { geminiEnabled: true, model: 'fake-live' });
});

test('full CRUD lifecycle', async () => {
  const created = await request(server)
    .post('/api/transcriptions')
    .send({ text: 'Mujhe ek coffee chahiye, please make it strong', language: 'hi-en' })
    .expect(201);
  assert.equal(created.body.title, 'Mujhe ek coffee chahiye, please make it strong');
  assert.equal(created.body.source, 'manual');

  const { id } = created.body;
  const fetched = await request(server).get(`/api/transcriptions/${id}`).expect(200);
  assert.equal(fetched.body.text, created.body.text);

  const updated = await request(server)
    .put(`/api/transcriptions/${id}`)
    .send({ title: 'Coffee order' })
    .expect(200);
  assert.equal(updated.body.title, 'Coffee order');
  assert.equal(updated.body.text, created.body.text);

  await request(server).delete(`/api/transcriptions/${id}`).expect(204);
  await request(server).get(`/api/transcriptions/${id}`).expect(404);
  await request(server).delete(`/api/transcriptions/${id}`).expect(404);
});

test('list supports search and pagination', async () => {
  for (const text of ['namaste duniya', 'hello world', 'aaj mausam accha hai', 'hello again']) {
    await request(server).post('/api/transcriptions').send({ text }).expect(201);
  }
  const all = await request(server).get('/api/transcriptions').expect(200);
  assert.equal(all.body.total, 4);
  assert.equal(all.body.items[0].text, 'hello again', 'newest first');

  const search = await request(server).get('/api/transcriptions?search=HELLO').expect(200);
  assert.equal(search.body.total, 2);

  const page = await request(server).get('/api/transcriptions?limit=3&offset=3').expect(200);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.total, 4);
});

test('validation errors return 400', async () => {
  await request(server).post('/api/transcriptions').send({}).expect(400);
  await request(server).post('/api/transcriptions').send({ text: '   ' }).expect(400);
  await request(server).post('/api/transcriptions').send({ text: 'ok', source: 'evil' }).expect(400);
  await request(server).put('/api/transcriptions/1').send({}).expect(400);
  await request(server).get('/api/transcriptions/abc').expect(400);
  await request(server).post('/api/transcriptions').set('Content-Type', 'application/json').send('{bad').expect(400);
});

function openSocket() {
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/transcribe`);
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    waiters.filter((w) => w.type === msg.type).forEach((w) => w.resolve(msg));
  });
  const waitFor = (type) => {
    const existing = messages.find((m) => m.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.push({ type, resolve }));
  };
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, messages, waitFor })));
}

test('websocket streams partial transcripts and persists the final one', async () => {
  const { ws, messages, waitFor } = await openSocket();
  ws.send(JSON.stringify({ type: 'start', language: 'hi-en' }));
  await waitFor('ready');

  const chunk = Buffer.alloc(3200); // 100 ms of 16 kHz PCM16
  for (let i = 0; i < 4; i++) ws.send(chunk);
  ws.send(JSON.stringify({ type: 'stop' }));
  const final = await waitFor('final');

  const partials = messages.filter((m) => m.type === 'partial').map((m) => m.text);
  assert.deepEqual(partials, ['Kal', 'Kal meeting', 'Kal meeting दस बजे', 'Kal meeting दस बजे hai']);
  assert.equal(final.text, 'Kal meeting दस बजे hai');
  assert.equal(final.record.source, 'gemini-live');
  assert.equal(fakeSessions[0].audioBytes, 4 * 3200);
  assert.ok(fakeSessions[0].ended && fakeSessions[0].closed);

  const stored = await request(server).get(`/api/transcriptions/${final.record.id}`).expect(200);
  assert.equal(stored.body.text, 'Kal meeting दस बजे hai');
  ws.close();
});

test('websocket with no speech saves nothing', async () => {
  const { ws, waitFor } = await openSocket();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor('ready');
  ws.send(JSON.stringify({ type: 'stop' }));
  const final = await waitFor('final');
  assert.equal(final.text, '');
  assert.equal(final.record, null);
  const list = await request(server).get('/api/transcriptions').expect(200);
  assert.equal(list.body.total, 0);
  ws.close();
});

test('closing the socket mid-stream closes the upstream session', async () => {
  const { ws, waitFor } = await openSocket();
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor('ready');
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fakeSessions[0].closed);
});
