import fs from "node:fs";
import path from "node:path";
import { run } from "./ffmpegUtils.js";

/** Concatenates multiple clips into a single compilation video using ffmpeg concat demuxer. */
export async function generateCompilation(clipPaths: string[], outputPath: string): Promise<void> {
  if (clipPaths.length === 0) throw new Error("Nenhum clipe para compilar.");

  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
    return;
  }

  const listPath = outputPath + ".list.txt";
  const lines = clipPaths
    .map((p) => `file '${path.resolve(p).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, lines);

  try {
    await run("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac",
      outputPath,
    ]);
  } finally {
    if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
  }
}
