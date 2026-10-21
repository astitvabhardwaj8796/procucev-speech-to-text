# Real-time Speech to Text (Hindi + English)

A web app that transcribes speech **in real time**, including code-mixed Hindi and English (Hinglish). Each finished transcription is saved to **PostgreSQL**. The **History** dashboard lets you create, read, update, delete and search them.

Built for the Procucev AI tech hiring assignment.

- **Live demo:** _<add deployed URL>_
- **Stack:** Node.js 20, Express, `ws`, PostgreSQL (`pg`), Gemini Live API (`@google/genai`), plain HTML/CSS/JS with no build step

## Features

- **Real-time transcription.** Words appear on screen while you speak.
- **Multilingual.** Gemini Live picks up Hindi, English and mixed speech without a language setting. Hindi comes out in Devanagari and English in Latin script.
- **Two speech engines:**
  - **Gemini Live (server).** The browser streams 16 kHz PCM audio to this server over a WebSocket. The server relays it to the Gemini Live API and streams the transcript back. The API key stays on the server.
  - **Browser Speech API.** A fallback that needs no API key (Chrome/Edge, `hi-IN` for Hinglish).
- **Persistence.** Finished transcriptions are saved with title, language, source engine and duration.
- **Dashboard with CRUD.** List with pagination, search, a manual "New entry" form, edit, delete and copy.
- **Tests.** Integration tests cover the REST API and the WebSocket streaming flow. A fake speech session stands in for Gemini, so the tests run without a key.

## Architecture

```
Browser                                   Node.js server                       Google
┌───────────────────────────┐  WebSocket  ┌──────────────────────────┐  Live API ┌──────────────┐
│ mic → AudioWorklet         │ ──PCM16──▶ │ /ws/transcribe           │ ────────▶ │ Gemini Live  │
│ (downsample to 16 kHz)     │ ◀─partial─ │  relays inputTranscription│ ◀──────── │  (STT)       │
│                            │ ◀─final──  │  saves final transcript   │           └──────────────┘
│ History dashboard ── REST ─┼──────────▶ │ /api/transcriptions (CRUD)│ ──▶ PostgreSQL
└───────────────────────────┘             └──────────────────────────┘
```

### WebSocket protocol (`/ws/transcribe`)

| Direction | Message |
|---|---|
| client → server | `{"type":"start","language":"hi-en"}` |
| client → server | binary frames: 16 kHz mono PCM16 little-endian, about 100 ms each |
| client → server | `{"type":"stop"}` |
| server → client | `{"type":"ready"}` |
| server → client | `{"type":"partial","text":"…"}` (the full transcript so far) |
| server → client | `{"type":"final","text":"…","record":{…}}` |
| server → client | `{"type":"error","message":"…"}` |

### REST API

| Method | Path | Description |
|---|---|---|
| GET | `/api/transcriptions?search=&limit=&offset=` | List, newest first → `{ items, total }` |
| GET | `/api/transcriptions/:id` | Get one |
| POST | `/api/transcriptions` | Create `{ text, title?, language?, source?, durationMs? }` |
| PUT | `/api/transcriptions/:id` | Update `{ title?, text?, language? }` |
| DELETE | `/api/transcriptions/:id` | Delete |
| GET | `/api/health` | Liveness and database check |
| GET | `/api/config` | Which engines are available |

### Database schema

```sql
CREATE TABLE transcriptions (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(200) NOT NULL,
  text        TEXT         NOT NULL,
  language    VARCHAR(32)  NOT NULL DEFAULT 'hi-en',
  source      VARCHAR(32)  NOT NULL DEFAULT 'manual',   -- gemini-live | browser | manual
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

The table is created automatically when the server starts.

## Run locally

**Requirements:** Node 20+ and PostgreSQL. You can get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
cp .env.example .env        # set DATABASE_URL and GEMINI_API_KEY
npm install
npm start                   # http://localhost:3000
```

Or run the app and the database together with Docker:

```bash
GEMINI_API_KEY=your-key docker compose up --build
```

Run the tests (they need an empty Postgres database):

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/speech_to_text_test npm test
```

## Deploy (Render, free tier)

1. Push this repository to GitHub.
2. On Render, choose **New → Blueprint** and select the repository. `render.yaml` creates the web service and a PostgreSQL database.
3. Set `GEMINI_API_KEY` when prompted, then deploy.

The browser only allows microphone access over HTTPS, and Render provides HTTPS.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | local Postgres | PostgreSQL connection string |
| `DATABASE_SSL` | `false` | Set to `true` for providers that require TLS |
| `GEMINI_API_KEY` | none | Turns on the Gemini Live engine |
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | The Live model to use |
| `FINALIZE_GRACE_MS` | `1500` | How long to wait for trailing words after Stop |

## Design notes

- **Server-side relay instead of a browser-to-Gemini connection.** The API key never reaches the browser, and the server can save the final transcript itself.
- **Audio format.** An AudioWorklet downsamples the microphone (usually 48 kHz) to the 16 kHz PCM16 that Gemini expects, using a box filter to limit aliasing.
- **Transcription only.** Native-audio Live models only reply with audio. The server turns on `inputAudioTranscription`, tells the model to stay silent, and ignores any reply it sends.
- **Limitations.** Without a Gemini key, only the browser engine is available, and it works in Chrome and Edge only. Gemini Live sessions are limited to about 15 minutes of audio.
