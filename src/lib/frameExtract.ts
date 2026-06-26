import { run } from "./ffmpegUtils.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Extrai um frame de um vídeo no instante `timeSec` e retorna como base64 JPEG.
 * Retorna null silenciosamente em caso de falha (ffmpeg ausente, seek inválido, etc.)
 * — o caller trata ausência de frames degradando graciosamente sem frames visuais.
 */
export async function extractFrameAsBase64(
  videoPath: string,
  timeSec: number,
  tmpDir: string
): Promise<string | null> {
  // Usa hrtime para nome único mesmo em chamadas paralelas
  const tmpPath = path.join(tmpDir, `frame_${process.hrtime.bigint()}.jpg`);
  try {
    await run(
      "ffmpeg",
      [
        "-y",
        "-ss", String(Math.max(0, timeSec)),
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "4",           // ~80–120 KB por frame
        "-vf", "scale=960:-2", // máx 960px de largura, mantém proporção
        tmpPath,
      ],
      30_000
    );
    if (!fs.existsSync(tmpPath)) return null;
    return fs.readFileSync(tmpPath).toString("base64");
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* noop */ }
  }
}
