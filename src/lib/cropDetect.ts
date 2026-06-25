import { probe } from "./ffmpegUtils.js";
import { spawn } from "node:child_process";

export interface CropInfo {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Uses ffmpeg cropdetect on the first ~5s to find the active video region. */
export async function detectCrop(videoPath: string): Promise<CropInfo> {
  const info = await probe(videoPath);

  const stderr = await new Promise<string>((resolve) => {
    const proc = spawn("ffmpeg", [
      "-i", videoPath,
      "-vf", "cropdetect=24:16:0",
      "-frames:v", "150",
      "-an",
      "-f", "null",
      "-",
    ]);
    let out = "";
    proc.stderr.on("data", (d) => (out += d.toString()));
    proc.on("close", () => resolve(out));
    proc.on("error", () => resolve(out));
  });

  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (matches.length === 0) {
    return { x: 0, y: 0, w: info.width, h: info.height };
  }

  // Pick the most frequent suggestion
  const counts = new Map<string, { crop: CropInfo; count: number }>();
  for (const m of matches) {
    const key = `${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
    if (counts.has(key)) {
      counts.get(key)!.count++;
    } else {
      counts.set(key, {
        crop: { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) },
        count: 1,
      });
    }
  }

  return [...counts.values()].sort((a, b) => b.count - a.count)[0].crop;
}

/** Extracts a single JPEG frame from the video at timeSec. */
export async function extractPreviewFrame(
  videoPath: string,
  outputPath: string,
  timeSec = 3
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-ss", String(timeSec),
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "4",
      outputPath,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Extração de frame falhou (${code})\n${stderr.slice(-2000)}`));
    });
    proc.on("error", reject);
  });
}
