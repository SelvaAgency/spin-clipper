import fs from "node:fs";
import { run } from "./ffmpegUtils.js";

export interface VideoInfo {
  title: string;
  durationSec: number;
  platform: string;
  thumbnailUrl?: string;
}

export interface DownloadOptions {
  /** Início do trecho em segundos (download parcial) */
  startSec?: number;
  /** Fim do trecho em segundos (download parcial) */
  endSec?: number;
}

function secToHMS(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ytdlpMissingError(): Error {
  return new Error(
    "O yt-dlp não foi encontrado no servidor. " +
    "Certifique-se de que a imagem Docker está atualizada (yt-dlp precisa estar instalado)."
  );
}

/**
 * Busca metadados de um vídeo sem baixá-lo.
 * Suporta: YouTube, Twitch, Kick, e qualquer plataforma suportada pelo yt-dlp.
 */
export async function getVideoInfo(url: string): Promise<VideoInfo> {
  let result: { stdout: string; stderr: string };
  try {
    result = await run(
      "yt-dlp",
      ["--dump-json", "--no-download", "--no-playlist", "--playlist-items", "1", url],
      60_000
    );
  } catch (err: any) {
    if (err.message.includes("não foi encontrado")) throw ytdlpMissingError();
    throw new Error(`Falha ao obter informações do vídeo: ${err.message}`);
  }

  // yt-dlp pode emitir avisos antes do JSON — pega a primeira linha com '{'
  const jsonLine = result.stdout.split("\n").find(l => l.trimStart().startsWith("{"));
  if (!jsonLine) {
    throw new Error("Resposta inesperada do yt-dlp ao buscar metadados.");
  }

  const info = JSON.parse(jsonLine);
  return {
    title:        info.title ?? url,
    durationSec:  Math.round(info.duration ?? 0),
    platform:     info.extractor_key ?? info.extractor ?? "unknown",
    thumbnailUrl: info.thumbnail,
  };
}

/**
 * Baixa um vídeo a partir de uma URL.
 *
 * Plataformas suportadas via yt-dlp: YouTube, Twitch VODs, Kick, e +1000 outras.
 * Conteúdo protegido (subscriber-only, age-restricted): configure a variável
 * de ambiente COOKIES_FILE apontando para um arquivo Netscape cookies.txt.
 *
 * Para downloads parciais (startSec/endSec), usa --download-sections do yt-dlp,
 * que baixa apenas os segmentos HLS/DASH necessários — sem baixar a live inteira.
 */
export async function downloadVideo(
  url: string,
  outputPath: string,
  onProgress?: (msg: string) => void,
  options?: DownloadOptions
): Promise<void> {
  onProgress?.("Verificando link...");

  const isPartial = options?.startSec !== undefined || options?.endSec !== undefined;

  // ── Tenta yt-dlp (YouTube, Twitch, Kick, etc.)
  try {
    if (isPartial) {
      const start = options!.startSec ?? 0;
      const end   = options!.endSec;
      const range = end !== undefined
        ? `${secToHMS(start)} → ${secToHMS(end)}`
        : `${secToHMS(start)} → fim`;
      onProgress?.(`Baixando trecho ${range} via yt-dlp...`);
    } else {
      onProgress?.("Baixando via yt-dlp...");
    }

    const args: string[] = [
      "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "-o", outputPath,
    ];

    // Cookies para conteúdo protegido (subscriber-only, etc.)
    const cookiesFile = process.env.COOKIES_FILE;
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      args.push("--cookies", cookiesFile);
      onProgress?.("Usando cookies configurados...");
    }

    if (isPartial) {
      const start   = options!.startSec ?? 0;
      const end     = options!.endSec;
      const section = end !== undefined
        ? `*${secToHMS(start)}-${secToHMS(end)}`
        : `*${secToHMS(start)}-inf`;
      args.push("--download-sections", section);
      // Re-encoda nos pontos de corte para timestamps precisos
      args.push("--force-keyframes-at-cuts");
    }

    args.push(url);
    await run("yt-dlp", args);

    if (fs.existsSync(outputPath)) {
      onProgress?.("Download concluído.");
      return;
    }
  } catch (err: any) {
    if (err.message.includes("não foi encontrado") || err.message.includes("yt-dlp não foi encontrado")) {
      throw ytdlpMissingError();
    }
    onProgress?.(`yt-dlp falhou (${err.message.split("\n")[0]}), tentando download direto...`);
  }

  // Downloads parciais exigem yt-dlp — não há fallback para HTTP com range
  if (isPartial) {
    throw new Error(
      "Download parcial não é possível sem o yt-dlp. " +
      "Certifique-se de que a imagem Docker está atualizada."
    );
  }

  // ── Fallback: download HTTP direto (apenas para links .mp4 ou similares)
  onProgress?.("Tentando download HTTP direto...");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar vídeo: HTTP ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("Resposta sem corpo ao baixar vídeo.");

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
