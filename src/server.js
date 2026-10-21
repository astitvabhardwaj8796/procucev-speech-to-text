const config = require('./config');
const { createRepository } = require('./db');
const { createServer } = require('./app');
const { createGeminiLiveSession } = require('./geminiLive');

async function main() {
  const repo = createRepository({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  await repo.migrate();

  const createSession = config.geminiApiKey
    ? (callbacks) => createGeminiLiveSession({ apiKey: config.geminiApiKey, model: config.geminiModel, ...callbacks })
    : null;
  if (!createSession) {
    console.warn('GEMINI_API_KEY not set: only the in-browser speech engine will be available.');
  }

  const server = createServer({
    repo,
    createSession,
    geminiModel: config.geminiModel,
    finalizeGraceMs: config.finalizeGraceMs,
  });
  server.listen(config.port, () => console.log(`Speech-to-Text running on http://localhost:${config.port}`));

  const shutdown = () => server.close(() => repo.close().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
