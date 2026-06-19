class OctosAudioInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }

    const input = inputs[0];
    const channel = input && input[0];
    if (!channel) return true;

    let read = 0;
    while (read < channel.length) {
      const available = this.buffer.length - this.offset;
      const take = Math.min(available, channel.length - read);
      this.buffer.set(channel.subarray(read, read + take), this.offset);
      this.offset += take;
      read += take;

      if (this.offset === this.buffer.length) {
        const samples = this.buffer;
        this.port.postMessage({ sampleRate, samples }, [samples.buffer]);
        this.buffer = new Float32Array(4096);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("octos-audio-input", OctosAudioInputProcessor);
