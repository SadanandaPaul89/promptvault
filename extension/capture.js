// Records the reel that's playing in the tab: audio (for server-side STT) plus
// a frame every second, cropped to the video, for on-screen-text OCR. Uses
// tabCapture, so it records exactly what the user sees and hears — no
// downloading of media from Instagram/LinkedIn servers.

const FRAME_EVERY_MS = 1000;
const MAX_FRAMES = 30;
/** Mean per-pixel difference (0–255) of a 16×16 thumbnail that counts as a new frame. */
const FRAME_CHANGE = 10;
/** Peak amplitude below which the recording is treated as silent (not uploaded). */
const SILENCE = 0.01;

function signature(source, sx, sy, sw, sh) {
  const c = new OffscreenCanvas(16, 16);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(source, sx, sy, sw, sh, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data;
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) | 0;
  return out;
}

function changed(a, b) {
  if (!a) return true;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length > FRAME_CHANGE;
}

/**
 * @param {number} tabId
 * @param {{ seconds: number, rect: {x:number,y:number,width:number,height:number}, viewport: {width:number,height:number} }} target
 * @param {(elapsed: number, total: number) => void} onProgress
 * @returns {Promise<{ audio: Blob | null, frames: Blob[] }>}
 */
export async function recordTab(tabId, target, onProgress) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 5 } },
  });

  // Tab capture mutes the tab for the user — play the audio back so they still hear it.
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let peak = 0;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType, audioBitsPerSecond: 32000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { recorder.onstop = r; });

  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = new MediaStream(stream.getVideoTracks());
  await video.play();

  const frames = [];
  let lastSig = null;
  const total = Math.max(3, target.seconds);
  const started = performance.now();
  recorder.start(1000);

  try {
    await new Promise((resolve) => {
      const meter = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        for (const s of samples) peak = Math.max(peak, Math.abs(s));
      }, 200);
      const tick = setInterval(async () => {
        const elapsed = (performance.now() - started) / 1000;
        onProgress(Math.min(elapsed, total), total);
        if (frames.length < MAX_FRAMES && video.videoWidth) {
          // Crop the captured tab frame to the video element (tab frame ≠ CSS pixels).
          const scale = video.videoWidth / target.viewport.width;
          const sx = Math.max(0, target.rect.x * scale);
          const sy = Math.max(0, target.rect.y * scale);
          const sw = Math.min(video.videoWidth - sx, target.rect.width * scale);
          const sh = Math.min(video.videoHeight - sy, target.rect.height * scale);
          if (sw > 50 && sh > 50) {
            const sig = signature(video, sx, sy, sw, sh);
            if (changed(lastSig, sig)) {
              lastSig = sig;
              const c = new OffscreenCanvas(Math.round(sw), Math.round(sh));
              c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
              frames.push(await c.convertToBlob({ type: "image/png" }));
            }
          }
        }
        if (elapsed >= total) {
          clearInterval(tick);
          clearInterval(meter);
          resolve();
        }
      }, FRAME_EVERY_MS);
    });
  } finally {
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  }

  const audio = peak > SILENCE ? new Blob(chunks, { type: mimeType }) : null;
  return { audio, frames };
}
