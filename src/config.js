require('dotenv').config();

const config = {
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/speech_to_text',
  // Most managed Postgres providers (Render, Neon, Supabase) require TLS.
  databaseSsl: process.env.DATABASE_SSL === 'true',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
  // How long to keep listening for trailing transcription after the user stops.
  finalizeGraceMs: Number(process.env.FINALIZE_GRACE_MS) || 1500,
};

module.exports = config;
