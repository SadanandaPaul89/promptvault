// Speech-to-text for reel audio via self-hosted whisper.cpp (no per-request API
// cost). ffmpeg converts whatever the extension recorded (webm/ogg/mp4) to
// 16 kHz mono WAV, then whisper-cli transcribes it. Jobs run one at a time so a
// burst of uploads can't pin every CPU core.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Transcriber = (audio: Buffer) => Promise<string>;

export type WhisperOptions = {
  ffmpegBin: string;
  whisperBin: string;
  model: string;
  /** Whisper language code, or "auto" (default — reels are often Hinglish). */
  language?: string;
  threads?: number;
  /** Max seconds of audio to transcribe. */
  maxSeconds?: number;
  timeoutMs?: number;
};

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${bin} failed: ${err.message}\n${String(stderr).slice(-500)}`));
      else resolve();
    });
  });
}

export function createWhisperTranscriber(o: WhisperOptions): Transcriber {
  let queue: Promise<unknown> = Promise.resolve();
  const timeoutMs = o.timeoutMs ?? 5 * 60_000;

  async function transcribe(audio: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pv-stt-"));
    try {
      const input = join(dir, "in.audio");
      const wav = join(dir, "audio.wav");
      const outBase = join(dir, "out");
      await writeFile(input, audio);
      await run(o.ffmpegBin, ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-t", String(o.maxSeconds ?? 120), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 60_000);
      await run(o.whisperBin, [
        "-m", o.model, "-f", wav, "-l", o.language ?? "auto", "-t", String(o.threads ?? 4),
        "-nt", "-otxt", "-of", outBase,
      ], timeoutMs);
      return (await readFile(`${outBase}.txt`, "utf8")).replace(/\s+/g, " ").trim();
    } finally {
      // Media is never kept — only the transcript text leaves this function.
      await rm(dir, { recursive: true, force: true });
    }
  }

  return (audio) => {
    const job = queue.then(() => transcribe(audio));
    queue = job.catch(() => undefined);
    return job;
  };
}

/** Builds a transcriber from env vars, or undefined when STT isn't configured. */
export function transcriberFromEnv(env: NodeJS.ProcessEnv): Transcriber | undefined {
  if (!env.WHISPER_BIN || !env.WHISPER_MODEL) return undefined;
  return createWhisperTranscriber({
    ffmpegBin: env.FFMPEG_BIN || "ffmpeg",
    whisperBin: env.WHISPER_BIN,
    model: env.WHISPER_MODEL,
    language: env.WHISPER_LANGUAGE || "auto",
    threads: env.WHISPER_THREADS ? Number(env.WHISPER_THREADS) : undefined,
  });
}
