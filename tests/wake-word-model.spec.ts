import { expect, test } from "@playwright/test";

test("wake-word model scores the bundled sample above the trigger threshold", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const withTimeout = async <T,>(
      promise: Promise<T>,
      label: string,
      ms: number,
    ): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });
    const [
      { loadWakeWordModel },
      {
        MODEL_AUDIO_WINDOW_SAMPLES,
        TARGET_SAMPLE_RATE,
        resampleLinear,
      },
    ] = await Promise.all([
      import("/src/home/voice/wake-word-model.ts"),
      import("/src/home/voice/wake-word-audio.ts"),
    ]);
    const model = await loadWakeWordModel("/wake-word/");
    const response = await fetch("/wake-word/sample-nihao-xiaozhangyu.wav");
    if (!response.ok) throw new Error(`sample fetch failed: ${response.status}`);

    const context = new AudioContext();
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        mono[i] += data[i] / decoded.numberOfChannels;
      }
    }
    const samples = resampleLinear(mono, decoded.sampleRate);
    const needed = MODEL_AUDIO_WINDOW_SAMPLES;
    const step = Math.round(0.05 * TARGET_SAMPLE_RATE);
    let score = 0;
    for (let end = Math.min(needed, samples.length); end <= samples.length; end += step) {
      const start = Math.max(0, end - needed);
      score = Math.max(
        score,
        await withTimeout(
          model.runAudio(samples.slice(start, end)),
          "wake score",
          15_000,
        ),
      );
    }
    await context.close();
    return {
      score,
      wakeWord: model.info.models[0]?.wake_word ?? "",
    };
  });

  expect(result.wakeWord).toBe("你好小章鱼");
  expect(result.score).toBeGreaterThan(0.4);
});
