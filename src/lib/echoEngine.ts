import { CAPTURE_DURATION_S, generateChirp } from "./chirp";

export interface CaptureResult {
  sampleRate: number;
  waveform: Float32Array; // full captured window, starting at recording start
  chirpStartSample: number; // index within waveform where the chirp was emitted
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContext({ latencyHint: "interactive" });
  }
  return sharedAudioContext;
}

export async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
}

/**
 * Emits a chirp through the speaker while simultaneously recording the
 * microphone, returning the raw captured window plus the sample index at
 * which the chirp was emitted (for cross-correlation alignment).
 */
export async function emitAndCapture(stream: MediaStream, chirpGain = 1.0): Promise<CaptureResult> {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  const sampleRate = ctx.sampleRate;
  const chirp = generateChirp(sampleRate);
  const captureLen = Math.round(CAPTURE_DURATION_S * sampleRate);

  const source = ctx.createMediaStreamSource(stream);
  const bufferSize = 4096;
  const processor = ctx.createScriptProcessor(bufferSize, 1, 1);

  const chunks: Float32Array[] = [];
  let collected = 0;
  let chirpStartSample: number | null = null;

  const donePromise = new Promise<void>((resolve) => {
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      collected += input.length;
      if (collected >= captureLen) {
        resolve();
      }
    };
  });

  // Silent connection required in some browsers to keep ScriptProcessor pumping.
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(ctx.destination);

  const recordingStartTime = ctx.currentTime;

  // Play chirp shortly after recording starts, so we capture a short pre-roll.
  const chirpBuffer = ctx.createBuffer(1, chirp.length, sampleRate);
  chirpBuffer.copyToChannel(chirp as Float32Array<ArrayBuffer>, 0);
  const chirpSource = ctx.createBufferSource();
  chirpSource.buffer = chirpBuffer;
  const chirpGainNode = ctx.createGain();
  chirpGainNode.gain.value = chirpGain;
  chirpSource.connect(chirpGainNode);
  chirpGainNode.connect(ctx.destination);
  const chirpDelay = 0.02; // 20ms pre-roll
  chirpSource.start(recordingStartTime + chirpDelay);
  chirpStartSample = Math.round(chirpDelay * sampleRate);

  await donePromise;

  processor.disconnect();
  source.disconnect();
  silentGain.disconnect();

  const waveform = new Float32Array(collected);
  let offset = 0;
  for (const chunk of chunks) {
    waveform.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    sampleRate,
    waveform: waveform.subarray(0, captureLen),
    chirpStartSample: chirpStartSample ?? 0,
  };
}
