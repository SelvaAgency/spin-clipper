import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { run } from "./ffmpegUtils.js";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface VideoInfo {
  title: string;
  durationSec: number;
  platform: string;
  thumbnailUrl?: string;
}

export interface DownloadOptions {
  /** Início do trecho em segundos */
  startSec?: number;
  /** Fim do trecho em segundos */
  endSec?: number;
  /** jobId para rastreamento de cancelamento */
  jobId?: string;
}

// ── Cancel registry ───────────────────────────────────────────────────────────

const activeDownloads = new Map<string, ChildProcess>();

/** Cancela um download em andamento. Retorna true se havia processo para matar. */
export function cancelDownload(jobId: string): boolean {
  const proc = activeDownloads.get(jobId);
  if (!proc) return false;
  proc.kill("SIGTERM");
  activeDownloads.delete(jobId);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function secToHMS(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ytdlpMissingError(): Error {
  return new Error(
    "O yt-dlp não foi encontrado no servidor. " +
    "Certifique-se de que a imagem Docker está atualizada."
  );
}

/**
 * Interpreta uma linha de progresso do yt-dlp.
 * Formato: [download]  23.4% of ~  2.50GiB at   8.52MiB/s ETA 04:47
 */
function parseYtdlpLine(line: string): string | null {
  const m = line.match(
    /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s)(?:.*?ETA\s+(\S+))?/
  );
  if (!m) return null;
  const [, pct, size, speed, eta] = m;
  let msg = `Baixando: ${pct}% de ${size} | ${speed}`;
  if (eta && eta !== "Unknown") msg += ` | ETA: ${eta}`;
  return msg;
}

/**
 * Interpreta uma linha de progresso do ffmpeg.
 * Formato: frame=0 fps=0.0 size=50000kB time=00:02:30.00 bitrate=... speed=10x
 */
function parseFfmpegLine(line: string, totalSec?: number): string | null {
  const timeM = line.match(/time=(\d{2}):(\d{2}):(\d{2})/);
  if (!timeM) return null;
  const elapsed = +timeM[1] * 3600 + +timeM[2] * 60 + +timeM[3];
  if (elapsed <= 0) return null;

  const sizeM  = line.match(/size=\s*(\d+)kB/);
  const speedM = line.match(/speed=\s*([\d.]+)x/);

  let msg = "Baixando:";
  if (totalSec && totalSec > 0) {
    const pct = Math.min(100, Math.round((elapsed / totalSec) * 100));
    msg += ` ${pct}% (${secToHMS(elapsed)} / ${secToHMS(totalSec)})`;
  } else {
    msg += ` ${secToHMS(elapsed)}`;
  }
  if (sizeM)  msg += ` | ${(parseInt(sizeM[1]) / 1024).toFixed(0)} MB`;
  if (speedM) msg += ` | ${speedM[1]}x`;
  return msg;
}

// ── Core streaming spawn ──────────────────────────────────────────────────────

/**
 * Executa um processo e entrega cada linha de saída em tempo real via onLine.
 * Em vez de timeout de parede (wall-clock), usa detecção de inatividade:
 * se não houver nenhuma saída (stdout/stderr) por stallMs → mata o processo.
 *
 * Isso permite downloads legítimos de qualquer duração enquanto protege contra
 * travamentos reais (rede morta, processo preso).
 */
function spawnProgress(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  opts: { jobId?: string; stallMs?: number } = {}
): Promise<void> {
  const stallMs = opts.stallMs ?? 120_000;
  const jobId   = opts.jobId;

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    if (jobId) activeDownloads.set(jobId, proc);

    let timedOut = false;
    let stallTimer: NodeJS.Timeout;

    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
        reject(new Error(
          `${cmd} parado por inatividade: sem saída por ${Math.round(stallMs / 1000)}s. ` +
          `Verifique a conexão ou tente um trecho menor.`
        ));
      }, stallMs);
    };

    resetStall();

    let stderrBuf = "";
    let stdoutBuf = "";

    proc.stdout.on("data", (d: Buffer) => {
      resetStall();
      stdoutBuf += d.toString();
      const parts = stdoutBuf.split("\n");
      stdoutBuf  = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) onLine(line.trim());
    });

    proc.stderr.on("data", (d: Buffer) => {
      resetStall();
      stderrBuf += d.toString();
      // yt-dlp e ffmpeg usam \r para sobrescrever a linha de progresso
      const parts = stderrBuf.split(/[\n\r]/);
      stderrBuf  = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) onLine(line.trim());
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(stallTimer);
      if (jobId) activeDownloads.delete(jobId);
      if (err.code === "ENOENT") {
        reject(new Error(`'${cmd}' não foi encontrado no servidor.`));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code, signal) => {
      clearTimeout(stallTimer);
      if (jobId) activeDownloads.delete(jobId);
      if (timedOut) return; // já rejeitou no stallTimer
      if (signal === "SIGTERM") {
        reject(new Error("Download cancelado pelo usuário."));
        return;
      }
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`${cmd} saiu com código ${code}\n${stderrBuf.slice(-2000)}`));
      }
    });
  });
}

// ── Fast HLS path (ffmpeg direct) ────────────────────────────────────────────

/**
 * Estratégia rápida para downloads parciais de streams HLS (Twitch, Kick).
 *
 * Passo 1 — yt-dlp extrai a URL direta do m3u8 (sem baixar nada ainda).
 * Passo 2 — ffmpeg usa -ss/-t/-c copy diretamente no m3u8:
 *   • Pula os segmentos antes do ponto de início (não baixa a live inteira)
 *   • Copia sem re-encodar (muito mais rápido do que --force-keyframes-at-cuts)
 *   • Progresso em tempo real via stderr do ffmpeg
 *
 * Se falhar (DASH com streams separados, URL com auth não-HLS), a chamada
 * rejeita e downloadVideo() faz fallback para yt-dlp nativo.
 */
async function downloadHlsDirect(
  url: string,
  outputPath: string,
  startSec: number,
  endSec: number | undefined,
  cookiesFile: string | undefined,
  onProgress: (msg: string) => void,
  jobId?: string
): Promise<void> {
  onProgress("Obtendo URL do stream HLS...");

  const ytArgs = [
    "-f", "best[protocol^=m3u8]/best",
    "--get-url",
    "--no-playlist",
  ];
  if (cookiesFile && fs.existsSync(cookiesFile)) {
    ytArgs.push("--cookies", cookiesFile);
  }
  ytArgs.push(url);

  const { stdout } = await run("yt-dlp", ytArgs, 30_000);
  const lines  = stdout.trim().split("\n").filter(l => l.startsWith("http"));

  // Só funciona com stream combinado (áudio+vídeo no mesmo m3u8)
  if (lines.length !== 1) {
    throw new Error(
      "Stream separado (DASH) detectado — usando yt-dlp nativo."
    );
  }

  const hlsUrl = lines[0];
  if (!hlsUrl.includes("m3u8") && !hlsUrl.includes(".m3u")) {
    throw new Error("URL obtida não é HLS — usando yt-dlp nativo.");
  }

  const duration = endSec !== undefined ? endSec - startSec : undefined;
  onProgress(
    `Stream HLS obtido. Baixando ${secToHMS(startSec)}${endSec ? ` → ${secToHMS(endSec)}` : " → fim"}...`
  );

  const ffArgs: string[] = [
    "-y",
    "-ss", String(startSec),
    "-i", hlsUrl,
    ...(duration !== undefined ? ["-t", String(duration)] : []),
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    outputPath,
  ];

  let lastProgressTime = 0;

  await spawnProgress("ffmpeg", ffArgs, (line) => {
    const progress = parseFfmpegLine(line, duration);
    if (progress) {
      const now = Date.now();
      if (now - lastProgressTime > 2_000) {
        lastProgressTime = now;
        onProgress(progress);
      }
    }
  }, { jobId, stallMs: 120_000 });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Busca metadados de um vídeo sem baixá-lo.
 * Suporta YouTube, Twitch, Kick e qualquer plataforma suportada pelo yt-dlp.
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

  const jsonLine = result.stdout.split("\n").find(l => l.trimStart().startsWith("{"));
  if (!jsonLine) throw new Error("Resposta inesperada do yt-dlp ao buscar metadados.");

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
 * Para downloads parciais (startSec/endSec):
 *   1. Tenta o caminho rápido: extrai URL HLS via yt-dlp + ffmpeg -c copy
 *      → sem re-encodar, só baixa os segmentos necessários
 *   2. Fallback: yt-dlp --download-sections sem --force-keyframes-at-cuts
 *      → segmento-preciso (±1 segmento ≈ ±10s), sem re-encode
 *
 * Para downloads completos: yt-dlp padrão com progresso em tempo real.
 *
 * COOKIES: configure COOKIES_FILE=/path/cookies.txt para conteúdo protegido.
 * CANCELAMENTO: passe options.jobId e use cancelDownload(jobId) para interromper.
 */
export async function downloadVideo(
  url: string,
  outputPath: string,
  onProgress?: (msg: string) => void,
  options?: DownloadOptions
): Promise<void> {
  const log        = onProgress ?? (() => {});
  const isPartial  = options?.startSec !== undefined || options?.endSec !== undefined;
  const jobId      = options?.jobId;
  const cookiesFile = process.env.COOKIES_FILE;

  log("Verificando link...");

  // ── Caminho 1: HLS direto via ffmpeg (downloads parciais) ──────────────────
  if (isPartial) {
    const start = options!.startSec ?? 0;
    const end   = options!.endSec;
    const range = end !== undefined
      ? `${secToHMS(start)} → ${secToHMS(end)}`
      : `${secToHMS(start)} → fim`;
    log(`Iniciando download parcial: ${range}`);

    try {
      await downloadHlsDirect(url, outputPath, start, end, cookiesFile, log, jobId);
      if (fs.existsSync(outputPath)) {
        log("Download concluído.");
        return;
      }
    } catch (err: any) {
      if (err.message.includes("cancelado")) throw err;
      if (err.message.includes("não foi encontrado")) throw ytdlpMissingError();
      // Fallback para yt-dlp nativo
      log(`HLS direto não disponível (${err.message.split("\n")[0]}). Tentando yt-dlp...`);
    }
  } else {
    log("Baixando via yt-dlp...");
  }

  // ── Caminho 2: yt-dlp (download completo ou fallback parcial) ──────────────
  try {
    const args: string[] = [
      "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-part",               // escreve direto no arquivo final
      "--concurrent-fragments", "4", // acelera downloads HLS
      "-o", outputPath,
    ];

    if (cookiesFile && fs.existsSync(cookiesFile)) {
      args.push("--cookies", cookiesFile);
      log("Usando cookies configurados...");
    }

    if (isPartial) {
      const start   = options!.startSec ?? 0;
      const end     = options!.endSec;
      const section = end !== undefined
        ? `*${secToHMS(start)}-${secToHMS(end)}`
        : `*${secToHMS(start)}-inf`;
      args.push("--download-sections", section);
      // --force-keyframes-at-cuts foi removido propositalmente:
      // ele re-encodava o vídeo inteiro → causava timeout de 20min+ em VODs longos.
      // Sem ele, o corte é feito na fronteira do segmento (±~10s), o que é
      // suficiente pois o usuário escolhe uma janela de horas, não segundos.
    }

    args.push(url);

    let lastProgressTime = 0;
    let lastSize = "";

    await spawnProgress("yt-dlp", args, (line) => {
      // Linha de progresso — throttle: no máximo 1 update a cada 3s
      const progress = parseYtdlpLine(line);
      if (progress) {
        const now = Date.now();
        if (now - lastProgressTime > 3_000) {
          lastProgressTime = now;
          log(progress);
        }
        return;
      }

      // Linhas informativas úteis (não spam de progresso)
      if (line.includes("Total fragments:")) {
        const m = line.match(/Total fragments:\s*(\d+)/);
        if (m) {
          const frags = parseInt(m[1]);
          log(`Segmentos HLS detectados: ${frags} (~${Math.round(frags / 6)} min)`);
        }
        return;
      }
      if (
        line.startsWith("[TwitchVOD]") ||
        line.startsWith("[youtube]") ||
        line.startsWith("[Kick]") ||
        line.startsWith("[info]") ||
        line.startsWith("[Merger]") ||
        line.includes("Destination:") ||
        line.includes("has already been downloaded")
      ) {
        log(line.slice(0, 120));
      }
    }, { jobId, stallMs: 180_000 }); // 3min de inatividade antes de considerar travado

    if (fs.existsSync(outputPath)) {
      log("Download concluído.");
      return;
    }
  } catch (err: any) {
    if (err.message.includes("cancelado")) throw err;
    if (err.message.includes("não foi encontrado")) throw ytdlpMissingError();
    if (isPartial) throw err; // sem fallback HTTP para parciais

    log(`yt-dlp falhou (${err.message.split("\n")[0]}), tentando download HTTP direto...`);
  }

  // ── Caminho 3: HTTP direto (apenas download completo de links .mp4) ─────────
  if (isPartial) {
    throw new Error(
      "Download parcial requer yt-dlp. " +
      "Certifique-se de que a imagem Docker está atualizada."
    );
  }

  log("Tentando download HTTP direto...");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar: HTTP ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("Resposta sem corpo.");

  const dest = fs.createWriteStream(outputPath);
  await new Promise<void>((resolve, reject) => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    function pump(): Promise<void> {
      return reader
        .read()
        .then(({ done, value }) => {
          if (done) { dest.end(); resolve(); return; }
          dest.write(value);
          return pump();
        })
        .catch(err => { dest.destroy(); reject(err); });
    }
    pump();
  });

  log("Download concluído.");
}
