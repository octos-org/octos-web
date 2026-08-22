class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      const samples = channel.slice();
      this.port.postMessage(samples, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
