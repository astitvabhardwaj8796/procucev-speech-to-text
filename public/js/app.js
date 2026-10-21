const $ = (id) => document.getElementById(id);

const ui = {
  engine: $('engine'),
  language: $('language'),
  langField: $('lang-field'),
  record: $('record'),
  recordLabel: $('record-label'),
  status: $('status'),
  timer: $('timer'),
  meter: $('meter-fill'),
  transcript: $('transcript'),
  engineNote: $('engine-note'),
  toast: $('toast'),
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let serverConfig = { geminiEnabled: false, model: null };
let recorder = null; // the active engine session
let timerHandle = null;

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastHandle;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => ui.toast.classList.remove('show'), 3000);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function setStatus(text) { ui.status.textContent = text; }

function renderTranscript(finalText, interimText = '') {
  ui.transcript.classList.remove('placeholder');
  ui.transcript.textContent = finalText;
  if (interimText) {
    const span = document.createElement('span');
    span.className = 'interim';
    span.textContent = (finalText ? ' ' : '') + interimText;
    ui.transcript.append(span);
  }
}

function setRecordingUi(recording) {
  ui.record.setAttribute('aria-pressed', String(recording));
  ui.recordLabel.textContent = recording ? 'Stop' : 'Start speaking';
  ui.engine.disabled = recording;
  ui.language.disabled = recording;
  if (recording) {
    const started = Date.now();
    ui.timer.textContent = '00:00';
    timerHandle = setInterval(() => { ui.timer.textContent = formatDuration(Date.now() - started); }, 250);
  } else {
    clearInterval(timerHandle);
    ui.meter.style.width = '0';
  }
}

// ---------------------------------------------------- Gemini Live engine
// Streams 16 kHz PCM16 audio to our server over a WebSocket. The server keeps the
// Gemini API key and relays Gemini's input transcription back in real time.

async function startGemini() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('js/pcm-worklet.js');
  const source = audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioCtx, 'pcm-downsampler');

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws/transcribe`);
  ws.binaryType = 'arraybuffer';

  const releaseAudio = () => {
    worklet.port.onmessage = null;
    source.disconnect();
    worklet.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close();
  };

  let resolveFinal;
  const finalPromise = new Promise((r) => { resolveFinal = r; });

  await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', language: 'hi-en' }));
    ws.onerror = () => reject(new Error('Could not reach the transcription server'));
    ws.onclose = () => { reject(new Error('Connection closed')); resolveFinal(null); };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ready') resolve();
      else if (msg.type === 'partial') renderTranscript(msg.text);
      else if (msg.type === 'final') resolveFinal(msg);
      else if (msg.type === 'error') {
        reject(new Error(msg.message));
        toast(msg.message);
        setStatus(`Error: ${msg.message}`);
      }
    };
  }).catch((err) => {
    releaseAudio();
    ws.close();
    throw err;
  });

  worklet.port.onmessage = ({ data }) => {
    ui.meter.style.width = `${Math.min(100, data.level * 400)}%`;
    if (ws.readyState === WebSocket.OPEN) ws.send(data.pcm);
  };
  source.connect(worklet);
  // Keep the worklet pulled by the audio graph without playing anything back.
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  worklet.connect(mute).connect(audioCtx.destination);

  return {
    async stop() {
      releaseAudio();
      if (ws.readyState !== WebSocket.OPEN) return null;
      ws.send(JSON.stringify({ type: 'stop' }));
      const final = await Promise.race([finalPromise, new Promise((r) => setTimeout(() => r(null), 10000))]);
      ws.close();
      return final;
    },
  };
}

// ------------------------------------------------ Browser speech engine
// Fallback that works without a Gemini key (Chrome / Edge). Saved via the REST API.

function startBrowser(lang) {
  if (!SpeechRecognition) throw new Error('This browser does not support the Web Speech API. Try Chrome or Edge.');
  const recognition = new SpeechRecognition();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalText = '';
  let active = true;
  let startedAt = Date.now();
  let stopResolve;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText = `${finalText} ${result[0].transcript}`.trim();
      else interim += result[0].transcript;
    }
    renderTranscript(finalText, interim.trim());
    ui.meter.style.width = interim ? '60%' : '0';
  };
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    toast(`Speech recognition error: ${event.error}`);
  };
  // Chrome ends recognition after a pause; keep listening until the user presses Stop.
  recognition.onend = () => {
    if (active) recognition.start();
    else stopResolve?.();
  };
  recognition.start();

  return {
    async stop() {
      active = false;
      await new Promise((resolve) => { stopResolve = resolve; recognition.stop(); });
      if (!finalText) return { text: '', record: null };
      const record = await api('/api/transcriptions', {
        method: 'POST',
        body: { text: finalText, language: lang === 'hi-IN' ? 'hi-en' : 'en', source: 'browser', durationMs: Date.now() - startedAt },
      });
      return { text: finalText, record };
    },
  };
}

// -------------------------------------------------------- record button

async function toggleRecording() {
  if (recorder) {
    ui.record.disabled = true;
    setStatus('Finalizing…');
    const active = recorder;
    recorder = null;
    setRecordingUi(false);
    try {
      const result = await active.stop();
      if (result?.text) renderTranscript(result.text);
      if (result?.record) {
        setStatus('Saved to history');
        toast('Transcription saved');
        history.dirty = true;
      } else {
        setStatus('Nothing was transcribed');
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      toast(err.message);
    } finally {
      ui.record.disabled = false;
    }
    return;
  }

  ui.record.disabled = true;
  setStatus('Connecting…');
  renderTranscript('');
  try {
    recorder = ui.engine.value === 'gemini' ? await startGemini() : startBrowser(ui.language.value);
    setRecordingUi(true);
    setStatus('Listening…');
  } catch (err) {
    recorder = null;
    setStatus(`Error: ${err.message}`);
    toast(err.message);
  } finally {
    ui.record.disabled = false;
  }
}

function updateEngineNote() {
  const gemini = ui.engine.value === 'gemini';
  ui.langField.hidden = gemini;
  ui.engineNote.textContent = gemini
    ? `Audio is streamed to the server and transcribed by ${serverConfig.model}. Hindi, English and mixed speech are detected automatically.`
    : 'Uses your browser’s built-in recognizer (Chrome/Edge). “Hindi + English” handles code-mixed speech best.';
}

// ------------------------------------------------------------- history

const history = {
  list: $('history-list'),
  search: $('search'),
  summary: $('history-summary'),
  prev: $('prev'),
  next: $('next'),
  pageInfo: $('page-info'),
  pageSize: 10,
  offset: 0,
  total: 0,
  dirty: true,
};

async function loadHistory() {
  const params = new URLSearchParams({ limit: history.pageSize, offset: history.offset });
  if (history.search.value.trim()) params.set('search', history.search.value.trim());
  try {
    const { items, total } = await api(`/api/transcriptions?${params}`);
    if (!items.length && total && history.offset) {
      history.offset = Math.max(0, history.offset - history.pageSize);
      return loadHistory();
    }
    history.total = total;
    history.dirty = false;
    renderHistory(items);
  } catch (err) {
    history.summary.textContent = `Could not load history: ${err.message}`;
  }
}

function renderHistory(items) {
  history.list.replaceChildren();
  history.summary.textContent = `${history.total} transcription${history.total === 1 ? '' : 's'}`;
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = history.search.value ? 'No matches.' : 'No transcriptions yet. Record one from the Live tab.';
    history.list.append(li);
  }
  for (const item of items) history.list.append(renderItem(item));

  const page = Math.floor(history.offset / history.pageSize) + 1;
  const pages = Math.max(1, Math.ceil(history.total / history.pageSize));
  history.pageInfo.textContent = `Page ${page} of ${pages}`;
  history.prev.disabled = history.offset === 0;
  history.next.disabled = history.offset + history.pageSize >= history.total;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function renderItem(item) {
  const sourceLabel = { 'gemini-live': 'Gemini Live', browser: 'Browser', manual: 'Manual' }[item.source] || item.source;
  const created = new Date(item.createdAt);
  const edited = item.updatedAt !== item.createdAt;

  const copy = el('button', { className: 'btn small', textContent: 'Copy' });
  copy.onclick = async () => { await navigator.clipboard.writeText(item.text); toast('Copied to clipboard'); };
  const edit = el('button', { className: 'btn small', textContent: 'Edit' });
  edit.onclick = () => openEditor(item);
  const del = el('button', { className: 'btn small danger', textContent: 'Delete' });
  del.onclick = async () => {
    if (!confirm(`Delete “${item.title}”?`)) return;
    try {
      await api(`/api/transcriptions/${item.id}`, { method: 'DELETE' });
      toast('Deleted');
      loadHistory();
    } catch (err) { toast(err.message); }
  };

  const badges = [el('span', { className: 'badge', textContent: sourceLabel }), el('span', { className: 'badge', textContent: item.language })];
  if (item.durationMs) badges.push(el('span', { className: 'badge', textContent: formatDuration(item.durationMs) }));
  if (edited) badges.push(el('span', { className: 'badge', textContent: 'edited' }));

  return el('li', { className: 'item' }, [
    el('div', { className: 'item-head' }, [
      el('h3', { textContent: item.title }),
      el('time', { dateTime: item.createdAt, textContent: created.toLocaleString() }),
    ]),
    el('p', { textContent: item.text }),
    el('div', { className: 'item-foot' }, [...badges, el('span', { className: 'spacer' }), copy, edit, del]),
  ]);
}

// --------------------------------------------------------------- editor

const editor = {
  dialog: $('editor'),
  form: $('editor-form'),
  heading: $('editor-title'),
  title: $('f-title'),
  text: $('f-text'),
  language: $('f-language'),
  error: $('editor-error'),
  current: null,
};

function openEditor(item = null) {
  editor.current = item;
  editor.heading.textContent = item ? 'Edit transcription' : 'New transcription';
  editor.title.value = item?.title || '';
  editor.title.placeholder = item ? '' : 'Optional — generated from text';
  editor.text.value = item?.text || '';
  editor.language.value = item?.language || 'hi-en';
  if (!editor.language.value) editor.language.value = 'hi-en';
  editor.error.textContent = '';
  editor.dialog.showModal();
}

editor.form.addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'save') return;
  event.preventDefault();
  const body = { text: editor.text.value, language: editor.language.value };
  if (editor.title.value.trim()) body.title = editor.title.value;
  try {
    if (editor.current) {
      await api(`/api/transcriptions/${editor.current.id}`, { method: 'PUT', body });
      toast('Updated');
    } else {
      await api('/api/transcriptions', { method: 'POST', body: { ...body, source: 'manual' } });
      history.offset = 0;
      toast('Created');
    }
    editor.dialog.close();
    loadHistory();
  } catch (err) {
    editor.error.textContent = err.message;
  }
});

// ------------------------------------------------------------- wiring

function showView(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('view-live').hidden = name !== 'live';
  $('view-history').hidden = name !== 'history';
  if (name === 'history' && history.dirty) loadHistory();
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
ui.record.addEventListener('click', toggleRecording);
ui.engine.addEventListener('change', updateEngineNote);
$('new-entry').addEventListener('click', () => openEditor());
history.prev.addEventListener('click', () => { history.offset = Math.max(0, history.offset - history.pageSize); loadHistory(); });
history.next.addEventListener('click', () => { history.offset += history.pageSize; loadHistory(); });
let searchHandle;
history.search.addEventListener('input', () => {
  clearTimeout(searchHandle);
  searchHandle = setTimeout(() => { history.offset = 0; loadHistory(); }, 250);
});

(async function init() {
  try { serverConfig = await api('/api/config'); } catch { /* keep defaults */ }
  const geminiOption = ui.engine.querySelector('option[value="gemini"]');
  if (!serverConfig.geminiEnabled) {
    geminiOption.disabled = true;
    geminiOption.textContent = 'Gemini Live (not configured on server)';
    ui.engine.value = 'browser';
  }
  if (!SpeechRecognition) ui.engine.querySelector('option[value="browser"]').disabled = true;
  updateEngineNote();
})();
