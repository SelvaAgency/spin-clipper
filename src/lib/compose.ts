import path from "node:path";
import fs from "node:fs";
import { run, probe } from "./ffmpegUtils.js";
import { getMoldura, VideoWindow } from "./molduras.js";

export interface ComposeInput {
  moldura: "split" | "full";
  streamerClip?: string;
  mesaClip?: string;
  fullSource?: "streamer" | "mesa";
  outputPath: string;
  primaryAudio?: "streamer" | "mesa" | "mix";
  /** User-approved crop applied before scaling (coordinates in the original video space) */
  streamerCrop?: { x: number; y: number; w: number; h: number };
  /** User-approved crop applied before scaling (coordinates in the original video space) */
  mesaCrop?: { x: number; y: number; w: number; h: number };
}

function buildVideoFilter(
  window: VideoWindow,
  inputLabel: string,
  outLabel: string,
  preCrop?: { x: number; y: number; w: number; h: number }
): string {
  const cropPart = preCrop
    ? `crop=${preCrop.w}:${preCrop.h}:${preCrop.x}:${preCrop.y},`
    : "";
  return (
    `[${inputLabel}]${cropPart}scale=${window.width}:${window.height}:force_original_aspect_ratio=increase,` +
    `crop=${window.width}:${window.height}[${outLabel}]`
  );
}

export async function composeMoldura(input: ComposeInput): Promise<void> {
  const moldura = getMoldura(input.moldura);
  const molduraPath = path.resolve("assets/molduras", moldura.file);

  if (moldura.windows.length === 2) {
    if (!input.streamerClip || !input.mesaClip) {
      throw new Error("Moldura 'split' precisa de streamerClip e mesaClip.");
    }
    return composeSplit(input, moldura.windows, molduraPath);
  } else {
    const source = input.fullSource === "mesa" ? input.mesaClip : input.streamerClip;
    if (!source) {
      throw new Error("Moldura 'full' precisa do clipe da fonte escolhida em fullSource.");
    }
    return composeFull(source, moldura.windows[0], moldura, molduraPath, input.outputPath, input);
  }
}

async function composeSplit(
  input: ComposeInput,
  windows: VideoWindow[],
  molduraPath: string
): Promise<void> {
  const [topWindow, bottomWindow] = windows;
  const moldura = getMoldura("split");

  // Probe clips so we can build a correct audio filter even when one track is absent.
  const [streamerInfo, mesaInfo] = await Promise.all([
    probe(input.streamerClip!),
    probe(input.mesaClip!),
  ]);

  console.log(
    `[compose] split — streamer: ${streamerInfo.width}x${streamerInfo.height} ` +
    `${streamerInfo.durationSec.toFixed(1)}s audio=${streamerInfo.hasAudio} | ` +
    `mesa: ${mesaInfo.width}x${mesaInfo.height} ` +
    `${mesaInfo.durationSec.toFixed(1)}s audio=${mesaInfo.hasAudio}`
  );

  console.log("[compose] ===== CROP UTILIZADO PELO FFMPEG =====");
  console.log(`[compose] streamer  x:${input.streamerCrop?.x ?? "—"} y:${input.streamerCrop?.y ?? "—"} w:${input.streamerCrop?.w ?? "—"} h:${input.streamerCrop?.h ?? "—"}`);
  console.log(`[compose] mesa      x:${input.mesaCrop?.x    ?? "—"} y:${input.mesaCrop?.y    ?? "—"} w:${input.mesaCrop?.w    ?? "—"} h:${input.mesaCrop?.h    ?? "—"}`);

  // ─── FIX: filter_complex com `color` cria fonte infinita.
  // Sem eof_action=endall no primeiro overlay, o grafo nunca emite EOS e
  // o ffmpeg trava esperando o filtro terminar — a Promise nunca resolve.
  //
  // Solução:
  //  • eof_action=endall no 1º overlay → grafo para quando `cam` termina.
  //  • eof_action=endall no último overlay → grafo para quando [tmp2] termina.
  //  • -stream_loop -1 no PNG → moldura loop infinito; não é o input mais
  //    curto, então -shortest termina nos clipes de vídeo (14 s), não no PNG (1 frame).
  const filter = [
    buildVideoFilter(topWindow, "0:v", "cam", input.streamerCrop),
    buildVideoFilter(bottomWindow, "1:v", "mesa", input.mesaCrop),
    `color=c=black:s=${moldura.canvasWidth}x${moldura.canvasHeight}[bg]`,
    `[bg][cam]overlay=${topWindow.x}:${topWindow.y}:eof_action=endall[tmp1]`,
    `[tmp1][mesa]overlay=${bottomWindow.x}:${bottomWindow.y}:eof_action=endall[tmp2]`,
    `[tmp2][2:v]overlay=0:0:eof_action=endall,format=yuv420p[outv]`,
  ].join(";");

  const audio = buildAudioFilter(
    input.primaryAudio ?? "streamer",
    streamerInfo.hasAudio,
    mesaInfo.hasAudio
  );

  const filterComplex = audio.filter ? `${filter};${audio.filter}` : filter;

  const args = [
    "-y",
    "-i", input.streamerClip!,
    "-i", input.mesaClip!,
    // -stream_loop -1 ANTES do -i do PNG para que ele seja lido em loop
    "-stream_loop", "-1", "-i", molduraPath,
    "-filter_complex", filterComplex,
    "-map", "[outv]",
    ...(audio.outLabel ? ["-map", audio.outLabel] : []),
    "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    ...(audio.outLabel ? ["-c:a", "aac", "-b:a", "160k"] : []),
    "-movflags", "+faststart",
    input.outputPath,
  ];

  console.log(`[compose] ffmpeg split args: ${args.join(" ")}`);
  await run("ffmpeg", args);
}

async function composeFull(
  sourceClip: string,
  window: VideoWindow,
  moldura: ReturnType<typeof getMoldura>,
  molduraPath: string,
  outputPath: string,
  input: ComposeInput
): Promise<void> {
  const srcInfo = await probe(sourceClip);
  console.log(
    `[compose] full — src: ${srcInfo.width}x${srcInfo.height} ` +
    `${srcInfo.durationSec.toFixed(1)}s audio=${srcInfo.hasAudio}`
  );

  const sourceCrop = input.fullSource === "mesa" ? input.mesaCrop : input.streamerCrop;
  console.log("[compose] ===== CROP UTILIZADO PELO FFMPEG =====");
  console.log(`[compose] full (${input.fullSource ?? "streamer"})  x:${sourceCrop?.x ?? "—"} y:${sourceCrop?.y ?? "—"} w:${sourceCrop?.w ?? "—"} h:${sourceCrop?.h ?? "—"}`);

  // Mesmo fix: eof_action=endall em todos os overlays + -stream_loop -1 no PNG.
  const filter = [
    buildVideoFilter(window, "0:v", "src", sourceCrop),
    `color=c=black:s=${moldura.canvasWidth}x${moldura.canvasHeight}[bg]`,
    `[bg][src]overlay=${window.x}:${window.y}:eof_action=endall[tmp1]`,
    `[tmp1][1:v]overlay=0:0:eof_action=endall,format=yuv420p[outv]`,
  ].join(";");

  const args = [
    "-y",
    "-i", sourceClip,
    "-stream_loop", "-1", "-i", molduraPath,
    "-filter_complex", filter,
    "-map", "[outv]",
    ...(srcInfo.hasAudio ? ["-map", "0:a"] : []),
    "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    ...(srcInfo.hasAudio ? ["-c:a", "aac", "-b:a", "160k"] : []),
    "-movflags", "+faststart",
    outputPath,
  ];

  console.log(`[compose] ffmpeg full args: ${args.join(" ")}`);
  await run("ffmpeg", args);
}

/**
 * Gera um PNG de debug com o frame original e um retângulo vermelho indicando
 * exatamente a área de crop que o FFmpeg usará. Salvo em debug/clip_NN_{streamer|mesa}.png
 */
export async function generateDebugFrame(
  sourcePath: string,
  timeSec: number,
  crop: { x: number; y: number; w: number; h: number },
  outputPath: string
): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-ss", String(Math.max(0, timeSec)),
    "-i", sourcePath,
    "-frames:v", "1",
    "-vf", `drawbox=x=${crop.x}:y=${crop.y}:w=${crop.w}:h=${crop.h}:color=red@0.8:t=4,scale=1280:-2`,
    outputPath,
  ], 30_000);
}

/**
 * Gera um PNG de pré-visualização da composição final (moldura + streamer + mesa).
 *
 * ARQUITETURA — two-step para evitar PTS mismatch:
 *
 *   Passo 1 — extrair frame de cada vídeo individualmente com `-ss N -frames:v 1`.
 *             Sem filter_complex, sem conflito de timestamps.
 *
 *   Passo 2 — compositar usando os PNGs estáticos como input (todos PTS=0),
 *             aplicando exatamente o mesmo crop/scale/overlay do vídeo final.
 *
 * O bug original: `-ss 5 -i video.mp4` preserva o PTS nativo do vídeo (~5s).
 * O `color` no filter_complex começa em PTS=0. O `overlay` exige timestamps
 * compatíveis — quando não casam, a área do vídeo sai preta no frame 0.
 */
export async function generateCompositionPreviewPng(opts: {
  moldura: "split" | "full";
  streamerPath?: string;
  mesaPath?: string;
  streamerCrop?: { x: number; y: number; w: number; h: number };
  mesaCrop?: { x: number; y: number; w: number; h: number };
  previewTimeSec?: number;
  outputPath: string;
}): Promise<void> {
  const moldura = getMoldura(opts.moldura);
  const molduraPath = path.resolve("assets/molduras", moldura.file);
  const t = Math.max(0, opts.previewTimeSec ?? 5);
  const previewDir = path.dirname(opts.outputPath);
  fs.mkdirSync(previewDir, { recursive: true });

  // ── Verificar moldura ──────────────────────────────────────────────────────
  if (!fs.existsSync(molduraPath)) {
    throw new Error(`[preview] Moldura não encontrada: ${molduraPath}`);
  }
  console.log(`[compose-preview] moldura: ${molduraPath} | ${fs.statSync(molduraPath).size}B`);

  // ── Passo 1: extrair frames estáticos de cada fonte ───────────────────────
  // Ao extrair sem filter_complex, o FFmpeg apenas salva o frame decodificado
  // sem nenhum problema de PTS — a imagem resultante começa sempre em t=0.

  const frameS = path.join(previewDir, "preview-streamer-debug.png");
  const frameM = path.join(previewDir, "preview-mesa-debug.png");

  async function extractStaticFrame(srcPath: string, destPath: string, label: string): Promise<void> {
    if (!fs.existsSync(srcPath)) {
      throw new Error(`[preview] Arquivo ${label} não encontrado: ${srcPath}`);
    }
    const srcSize = fs.statSync(srcPath).size;
    console.log(`[compose-preview] ${label} fonte: ${srcPath} | ${srcSize}B`);
    if (srcSize === 0) throw new Error(`[preview] Arquivo ${label} está vazio: ${srcPath}`);

    await run("ffmpeg", [
      "-y",
      "-ss", String(t),
      "-i", srcPath,
      "-frames:v", "1",
      destPath,
    ], 30_000);

    if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
      throw new Error(`[preview] Frame ${label} não foi gerado: ${destPath}`);
    }
    console.log(`[compose-preview] ${label} frame: ${destPath} | ${fs.statSync(destPath).size}B ✓`);
  }

  // ── Passo 2: compositar com PNGs estáticos (todos PTS=0, sem conflito) ────

  if (moldura.windows.length === 2) {
    if (!opts.streamerPath || !opts.mesaPath) {
      throw new Error("Preview split requer streamerPath e mesaPath.");
    }

    await extractStaticFrame(opts.streamerPath, frameS, "streamer");

    if (opts.mesaPath === opts.streamerPath) {
      // Split de fonte única — mesmo frame para as duas janelas
      fs.copyFileSync(frameS, frameM);
      console.log(`[compose-preview] mesa usa mesma fonte — reutilizando frame do streamer`);
    } else {
      await extractStaticFrame(opts.mesaPath, frameM, "mesa");
    }

    const [top, bot] = moldura.windows;
    const sCrop = opts.streamerCrop
      ? `crop=${opts.streamerCrop.w}:${opts.streamerCrop.h}:${opts.streamerCrop.x}:${opts.streamerCrop.y},`
      : "";
    const mCrop = opts.mesaCrop
      ? `crop=${opts.mesaCrop.w}:${opts.mesaCrop.h}:${opts.mesaCrop.x}:${opts.mesaCrop.y},`
      : "";

    console.log(`[compose-preview] split crop streamer=${sCrop || "(none)"} mesa=${mCrop || "(none)"}`);
    console.log(`[compose-preview] windows top=${top.x},${top.y} ${top.width}x${top.height} | bot=${bot.x},${bot.y} ${bot.width}x${bot.height}`);

    const filter = [
      `[0:v]${sCrop}scale=${top.width}:${top.height}:force_original_aspect_ratio=increase,crop=${top.width}:${top.height}[cam]`,
      `[1:v]${mCrop}scale=${bot.width}:${bot.height}:force_original_aspect_ratio=increase,crop=${bot.width}:${bot.height}[mesa]`,
      `color=c=black:s=${moldura.canvasWidth}x${moldura.canvasHeight}[bg]`,
      `[bg][cam]overlay=${top.x}:${top.y}[tmp1]`,
      `[tmp1][mesa]overlay=${bot.x}:${bot.y}[tmp2]`,
      `[tmp2][2:v]overlay=0:0,format=rgb24[out]`,
    ].join(";");

    // Entradas estáticas: todos PTS=0 — sem conflito de timestamps no overlay
    await run("ffmpeg", [
      "-y",
      "-loop", "1", "-i", frameS,
      "-loop", "1", "-i", frameM,
      "-loop", "1", "-i", molduraPath,
      "-filter_complex", filter,
      "-map", "[out]",
      "-frames:v", "1",
      opts.outputPath,
    ], 60_000);

  } else {
    const sourcePath = opts.streamerPath ?? opts.mesaPath;
    if (!sourcePath) throw new Error("Preview full requer streamerPath ou mesaPath.");
    const [win] = moldura.windows;
    const crop = opts.streamerPath ? opts.streamerCrop : opts.mesaCrop;
    const cropPart = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
    const frameFile = opts.streamerPath ? frameS : frameM;

    await extractStaticFrame(sourcePath, frameFile, opts.streamerPath ? "streamer" : "mesa/full");

    console.log(`[compose-preview] full crop=${cropPart || "(none)"} window=${win.x},${win.y} ${win.width}x${win.height}`);

    const filter = [
      `[0:v]${cropPart}scale=${win.width}:${win.height}:force_original_aspect_ratio=increase,crop=${win.width}:${win.height}[src]`,
      `color=c=black:s=${moldura.canvasWidth}x${moldura.canvasHeight}[bg]`,
      `[bg][src]overlay=${win.x}:${win.y}[tmp1]`,
      `[tmp1][1:v]overlay=0:0,format=rgb24[out]`,
    ].join(";");

    await run("ffmpeg", [
      "-y",
      "-loop", "1", "-i", frameFile,
      "-loop", "1", "-i", molduraPath,
      "-filter_complex", filter,
      "-map", "[out]",
      "-frames:v", "1",
      opts.outputPath,
    ], 60_000);
  }

  // ── Verificação final ──────────────────────────────────────────────────────
  if (!fs.existsSync(opts.outputPath)) {
    throw new Error(`[preview] Arquivo de saída não foi criado: ${opts.outputPath}`);
  }
  const outSize = fs.statSync(opts.outputPath).size;
  if (outSize === 0) {
    throw new Error(`[preview] Arquivo de saída está vazio: ${opts.outputPath}`);
  }
  console.log(`[compose-preview] ✓ composição: ${opts.outputPath} | ${outSize}B`);
  if (outSize < 20_000) {
    console.warn(`[compose-preview] AVISO: preview muito pequeno (${outSize}B) — possível frame predominantemente preto`);
  }

  // Salvar cópia de debug da composição final
  const debugComp = path.join(previewDir, "preview-composition-debug.png");
  fs.copyFileSync(opts.outputPath, debugComp);
}

/**
 * Constrói o filtro de áudio levando em conta se cada clip tem trilha.
 * Evita mapear streams inexistentes, que causam erro de ffmpeg.
 */
function buildAudioFilter(
  mode: "streamer" | "mesa" | "mix",
  streamerHasAudio: boolean,
  mesaHasAudio: boolean
): { filter: string; outLabel: string | null } {
  const noAudio = { filter: "", outLabel: null };

  if (mode === "mix") {
    if (streamerHasAudio && mesaHasAudio) {
      return {
        filter: `[0:a]volume=1.0[a0];[1:a]volume=0.25[a1];[a0][a1]amix=inputs=2:duration=longest[outa]`,
        outLabel: "[outa]",
      };
    }
    if (streamerHasAudio) return { filter: `[0:a]anull[outa]`, outLabel: "[outa]" };
    if (mesaHasAudio) return { filter: `[1:a]anull[outa]`, outLabel: "[outa]" };
    return noAudio;
  }

  if (mode === "streamer") {
    if (streamerHasAudio) return { filter: `[0:a]anull[outa]`, outLabel: "[outa]" };
    if (mesaHasAudio) return { filter: `[1:a]anull[outa]`, outLabel: "[outa]" };
    return noAudio;
  }

  // mode === "mesa"
  if (mesaHasAudio) return { filter: `[1:a]anull[outa]`, outLabel: "[outa]" };
  if (streamerHasAudio) return { filter: `[0:a]anull[outa]`, outLabel: "[outa]" };
  return noAudio;
}
