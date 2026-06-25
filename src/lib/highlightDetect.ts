import { run } from "./ffmpegUtils.js";

export interface AudioCandidate {
  centerSec: number;
  peakDb: number;
}

export interface DetectOptions {
  windowSec?: number;
  thresholdAboveMeanDb?: number;
  minGapSec?: number;
}

export async function detectAudioCandidates(
  filePath: string,
  opts: DetectOptions = {}
): Promise<AudioCandidate[]> {
  const windowSec = opts.windowSec ?? 1;
  const thresholdAboveMeanDb = opts.thresholdAboveMeanDb ?? 0.5;
  const minGapSec = opts.minGapSec ?? 5;

  const sampleRate = 16000;
  const samplesPerWindow = Math.round(sampleRate * windowSec);

  const { stdout } = await run("ffmpeg", [
    "-i",
    filePath,
    "-af",
    `aresample=${sampleRate},asetnsamples=n=${samplesPerWindow}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:file=-`,
    "-f",
    "null",
    "-",
  ]);

  const rmsRegex = /lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?)/g;

  const levels: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = rmsRegex.exec(stdout)) !== null) {
    const v = parseFloat(match[1]);
    if (Number.isFinite(v)) levels.push(v);
  }

  console.log("Levels encontrados:", levels.length);

  if (levels.length === 0) {
    console.log("Nenhum RMS encontrado pelo FFmpeg.");
    return [];
  }

  const finiteLevels = levels.filter((v) => v > -90);

  const mean =
    finiteLevels.reduce((a, b) => a + b, 0) /
    Math.max(finiteLevels.length, 1);

  const max = Math.max(...levels);
  const min = Math.min(...levels);

  console.log("Mean:", mean);
  console.log("Max:", max);
  console.log("Min:", min);
  console.log("Threshold:", mean + thresholdAboveMeanDb);

  const rawPeaks: AudioCandidate[] = [];

  levels.forEach((db, i) => {
    if (db > mean + thresholdAboveMeanDb) {
      rawPeaks.push({
        centerSec: i * windowSec,
        peakDb: db,
      });
    }
  });

  console.log("Raw peaks:", rawPeaks.length);

  const merged: AudioCandidate[] = [];

  for (const peak of rawPeaks.sort((a, b) => a.centerSec - b.centerSec)) {
    const last = merged[merged.length - 1];

    if (last && peak.centerSec - last.centerSec < minGapSec) {
      if (peak.peakDb > last.peakDb) {
        merged[merged.length - 1] = peak;
      }
    } else {
      merged.push(peak);
    }
  }

  console.log("Merged peaks:", merged.length);

  return merged.sort((a, b) => b.peakDb - a.peakDb);
}