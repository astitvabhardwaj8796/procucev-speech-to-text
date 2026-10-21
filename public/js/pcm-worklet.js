// Converts the microphone stream (usually 44.1/48 kHz float32) into
// 16 kHz mono PCM16 chunks of ~100 ms, the format Gemini Live expects.
const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.phase = 0;
    this.acc = 0;
    this.count = 0;
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Box-filter average over each output period to limit aliasing.
      this.acc += channel[i];
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        const sample = Math.max(-1, Math.min(1, this.acc / this.count));
        this.sumSquares += sample * sample;
        this.out[this.outLen++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        this.acc = 0;
        this.count = 0;
        this.phase -= this.ratio;

        if (this.outLen === CHUNK_SAMPLES) {
          const level = Math.sqrt(this.sumSquares / CHUNK_SAMPLES);
          this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
          this.out = new Int16Array(CHUNK_SAMPLES);
          this.outLen = 0;
          this.sumSquares = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
