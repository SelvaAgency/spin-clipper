import fs from "node:fs";
import { run } from "./ffmpegUtils.js";

export async function downloadVideo(
  url: string,
  outputPath: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  onProgress?.("Verificando link...");

  // Try yt-dlp first (YouTube, Twitch, etc.)
  try {
    onProgress?.("Tentando baixar com yt-dlp...");
    await run("yt-dlp", [
      "-o", outputPath,
      "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      url,
    ]);
    if (fs.existsSync(outputPath)) {
      onProgress?.("Download concluído via yt-dlp.");
      return;
    }
  } catch {
    onProgress?.("yt-dlp não disponível ou falhou, tentando download direto...");
  }

  // Direct HTTP download for raw video URLs
  onProgress?.("Baixando vídeo diretamente...");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar vídeo: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("Resposta vazia ao baixar vídeo.");

  const dest = fs.createWriteStream(outputPath);

  await new Promise<void>((resolve, reject) => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    function pump(): Promise<void> {
      return reader.read().then(({ done, value }) => {
        if (done) {
          dest.end();
          resolve();
          return;
        }
        dest.write(value);
        return pump();
      }).catch((err) => { dest.destroy(); reject(err); });
    }

    pump();
  });

  onProgress?.("Download concluído.");
}
