const { GoogleGenAI, Modality } = require('@google/genai');

// Native-audio Live models only answer with AUDIO, so we ask the model to stay
// quiet and only consume the input-audio transcription events.
const SYSTEM_INSTRUCTION = `You are a silent speech transcription service.
The user speaks a mix of Hindi and English (Hinglish). Do not answer, translate,
or comment on anything the user says. Never produce a reply.`;

/**
 * Opens a Gemini Live session that streams back transcription of the audio we send.
 * Returns a small adapter so the WebSocket handler does not depend on the SDK directly.
 */
async function createGeminiLiveSession({ apiKey, model, onTranscript, onError, onClose }) {
  const ai = new GoogleGenAI({ apiKey });
  const session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      systemInstruction: SYSTEM_INSTRUCTION,
    },
    callbacks: {
      onmessage(message) {
        const text = message.serverContent?.inputTranscription?.text;
        if (text) onTranscript(text);
      },
      onerror(event) {
        onError(new Error(event?.message || 'Gemini Live error'));
      },
      onclose(event) {
        onClose(event?.reason || '');
      },
    },
  });

  return {
    sendAudio(pcm16Buffer) {
      session.sendRealtimeInput({
        audio: { data: pcm16Buffer.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      });
    },
    endAudio() {
      session.sendRealtimeInput({ audioStreamEnd: true });
    },
    close() {
      session.close();
    },
  };
}

module.exports = { createGeminiLiveSession };
