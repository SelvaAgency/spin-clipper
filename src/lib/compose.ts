import path from "node:path";
import { run, probe } from "./ffmpegUtils.js";
import { getMoldura, VideoWindow } from "./molduras.js";

export interface ComposeInput {
  moldura: "split" | "full";
  streamerClip?: string;
  mesaClip?: string;
  fullSource?: "streamer" | "mesa";
  outputPath: string;
  primaryAudio?: "streamer" | "mesa" | "mix";
}

function scaleCropFilter(window: VideoWindow, inputLabel: string, outLabel: string): string {
  return (
    `[${inputLabel}]scale=${window.width}:${window.height}:force_original_aspect_ratio=increase,` +
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
    return composeFull(source, moldura.windows[0], moldura, molduraPath, input.outputPath);
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
    scaleCropFilter(topWindow, "0:v", "cam"),
    scaleCropFilter(bottomWindow, "1:v", "mesa"),
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
  outputPath: string
): Promise<void> {
  const srcInfo = await probe(sourceClip);
  console.log(
    `[compose] full — src: ${srcInfo.width}x${srcInfo.height} ` +
    `${srcInfo.durationSec.toFixed(1)}s audio=${srcInfo.hasAudio}`
  );

  // Mesmo fix: eof_action=endall em todos os overlays + -stream_loop -1 no PNG.
  const filter = [
    scaleCropFilter(window, "0:v", "src"),
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
