const { WebSocketServer } = require('ws');
const { deriveTitle } = require('./validation');

/**
 * WebSocket protocol (path: /ws/transcribe)
 *   client -> server  {"type":"start","language":"hi-en"}   open a Gemini Live session
 *   client -> server  <binary>                              16 kHz mono PCM16 little-endian audio
 *   client -> server  {"type":"stop"}                       finish, persist and return the transcript
 *   server -> client  {"type":"ready"}
 *   server -> client  {"type":"partial","text":"..."}        full transcript so far (real-time)
 *   server -> client  {"type":"final","text":"...","record":{...}|null}
 *   server -> client  {"type":"error","message":"..."}
 */
function attachTranscribeSocket(server, { repo, createSession, finalizeGraceMs }) {
  const wss = new WebSocketServer({ server, path: '/ws/transcribe', maxPayload: 1024 * 1024 });

  wss.on('connection', (ws) => {
    let session = null;
    let transcript = '';
    let language = 'hi-en';
    let startedAt = 0;
    let state = 'idle'; // idle -> starting -> live -> stopping -> idle

    const send = (payload) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };
    const normalized = () => transcript.replace(/\s+/g, ' ').trim();

    const closeSession = () => {
      if (session) {
        try { session.close(); } catch { /* already closed */ }
        session = null;
      }
    };

    async function start(msg) {
      if (state !== 'idle') return send({ type: 'error', message: 'A transcription is already running' });
      if (!createSession) return send({ type: 'error', message: 'Gemini Live is not configured on the server (GEMINI_API_KEY missing)' });
      state = 'starting';
      transcript = '';
      language = typeof msg.language === 'string' ? msg.language.slice(0, 32) : 'hi-en';
      try {
        session = await createSession({
          onTranscript(chunk) {
            transcript += chunk;
            send({ type: 'partial', text: normalized() });
          },
          onError(err) {
            send({ type: 'error', message: err.message });
          },
          onClose(reason) {
            session = null;
            if (state === 'live') {
              state = 'idle';
              send({ type: 'error', message: `Speech service closed the session${reason ? `: ${reason}` : ''}` });
            }
          },
        });
        startedAt = Date.now();
        state = 'live';
        send({ type: 'ready' });
      } catch (err) {
        state = 'idle';
        send({ type: 'error', message: `Could not connect to speech service: ${err.message}` });
      }
    }

    async function stop() {
      // The upstream session may already have dropped; still answer so the client can finish.
      if (state === 'idle') return send({ type: 'final', text: normalized(), record: null });
      if (state !== 'live') return;
      state = 'stopping';
      try { session?.endAudio(); } catch { /* session may already be gone */ }
      // Transcription of the final words arrives shortly after the audio ends.
      await new Promise((r) => setTimeout(r, finalizeGraceMs));
      closeSession();
      const text = normalized();
      let record = null;
      if (text) {
        try {
          record = await repo.create({
            title: deriveTitle(text),
            text,
            language,
            source: 'gemini-live',
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          send({ type: 'error', message: `Failed to save transcription: ${err.message}` });
        }
      }
      state = 'idle';
      send({ type: 'final', text, record });
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (state === 'live' && session) session.sendAudio(Buffer.from(data));
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return send({ type: 'error', message: 'Invalid JSON message' }); }
      if (msg.type === 'start') start(msg);
      else if (msg.type === 'stop') stop();
      else send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    });

    ws.on('close', () => {
      state = 'idle';
      closeSession();
    });
  });

  return wss;
}

module.exports = { attachTranscribeSocket };
