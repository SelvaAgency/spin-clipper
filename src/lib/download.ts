import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { run } from "./ffmpegUtils.js";

const execAsync = promisify(execFile);

export interface VideoInfo {
  title: string;
  durationSec: number;
  platform: string;
  thumbnailUrl?: string;
}

export interface DownloadOptions {
  startSec?: number;
  endSec?: number;
}

function secToHMS(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Busca metadados do vídeo sem baixar. Requer yt-dlp instalado. */
export async function getVideoInfo(url: string): Promise<VideoInfo> {
  const { stdout } = await execAsync(
    "yt-dlp",
    ["--dump-json", "--no-download", "--no-playlist", "--playlist-items", "1", url],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
  );
  // yt-dlp pode emitir linhas de progresso antes do JSON — pega a primeira linha com '{'
  const jsonLine = stdout.split("\n").find(l => l.trimStart().startsWith("{"));
  if (!jsonLine) throw new Error("Resposta inesperada do yt-dlp.");
  const info = JSON.parse(jsonLine);
  return {
    title:       info.title ?? url,
    durationSec: Math.round(info.duration ?? 0),
    platform:    info.extractor_key ?? info.extractor ?? "unknown",
    thumbnailUrl: info.thumbnail,
  };
}

export async function downloadVideo(
  url: string,
  outputPath: string,
  onProgress?: (msg: string) => void,
  options?: DownloadOptions
): Promise<void> {
  onProgress?.("Verificando link...");

  const isPartial = options?.startSec !== undefined || options?.endSec !== undefined;

  // ── Try yt-dlp (YouTube, Twitch, Kick, etc.)
  try {
    if (isPartial) {
      const start = options!.startSec ?? 0;
      const end   = options!.endSec;
      const range = end !== undefined ? `${secToHMS(start)}–${secToHMS(end)}` : `${secToHMS(start)}→fim`;
      onProgress?.(`Baixando trecho ${range} via yt-dlp...`);
    } else {
      onProgress?.("Tentando baixar com yt-dlp...");
    }

    const args: string[] = [
      "-o", outputPath,
      "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
    ];

    if (isPartial) {
      const start = options!.startSec ?? 0;
      const end   = options!.endSec;
      const section = end !== undefined
        ? `*${secToHMS(start)}-${secToHMS(end)}`
        : `*${secToHMS(start)}-inf`;
      args.push("--download-sections", section);
      // Re-encode at cut points for accurate trim (adds ~30s overhead, avoids timestamp drift)
      args.push("--force-keyframes-at-cuts");
    }

    args.push(url);
    await run("yt-dlp", args);

    if (fs.existsSync(outputPath)) {
      onProgress?.("Download concluído via yt-dlp.");
      return;
    }
  } catch {
    onProgress?.("yt-dlp não disponível ou falhou, tentando download direto...");
  }

  // Partial not possible without yt-dlp
  if (isPartial) {
    throw new Error(
      "Download parcial requer yt-dlp. Instale com: pip install yt-dlp"
    );
  }

  // ── Direct HTTP fallback (for raw .mp4 links)
  onProgress?.("Baixando vídeo diretamente...");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar vídeo: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("Resposta vazia ao baixar vídeo.");

  const dest = fs.createWriteStream(outputPath);
  await new Promise<void>((resolve, reject) => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    function pump(): Promise<void> {
      return reader.read().then(({ done, value }) => {
        if (done) { dest.end(); resolve(); return; }
        dest.write(value);
        return pump();
      }).catch(err => { dest.destroy(); reject(err); });
    }
    pump();
  });

  onProgress?.("Download concluído.");
}
