import path from "node:path";
import { run } from "./ffmpegUtils.js";
import { getMoldura, VideoWindow } from "./molduras.js";

export interface ComposeInput {
  /** "split" usa MOLDURA_SPIN.png (2 janelas), "full" usa MOLDURA_SPIN2.png (1 janela). */
  moldura: "split" | "full";
  /** Clipe já cortado (in/out) da câmera do streamer. Obrigatório em "split" e em "full" quando fullSource === "streamer". */
  streamerClip?: string;
  /** Clipe já cortado (in/out) da mesa/roleta. Obrigatório em "split" e em "full" quando fullSource === "mesa". */
  mesaClip?: string;
  /** Em modo "full", qual das duas fontes preenche a janela única. */
  fullSource?: "streamer" | "mesa";
  outputPath: string;
  /** Qual áudio usar como trilha principal do clipe. Default: streamer. */
  primaryAudio?: "streamer" | "mesa" | "mix";
}

function scaleCropFilter(window: VideoWindow, inputLabel: string, outLabel: string): string {
  // scale "increase" garante que o vídeo cubra a janela inteira (cover-fit), depois crop centraliza o excesso.
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

  const filter = [
    scaleCropFilter(topWindow, "0:v", "cam"),
    scaleCropFilter(bottomWindow, "1:v", "mesa"),
    `color=c=black:s=${moldura.canvasWidth}x${moldura.canvasHeight}[bg]`,
    `[bg][cam]overlay=${topWindow.x}:${topWindow.y}[tmp1]`,
    `[tmp1][mesa]overlay=${bottomWindow.x}:${bottomWindow.y}[tmp2]`,
    `[tmp2][2:v]overlay=0:0,format=yuv420p[outv]`,
  ].join(";");

  const audioFilter = buildAudioFilter(input.primaryAudio ?? "streamer");

  const args = [
    "-y",
    "-i", input.streamerClip!,
    "-i", input.mesaClip!,
    "-i", molduraPath,
    "-filter_complex", `${filter};${audioFilter.filter}`,
    "-map", "[outv]",
    "-map", audioFilter.outLabel,
    "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    input.outputPath,
  ];

  await run("ffmpeg", args);
}

async function composeFull(
  sourceClip: string,
  window: VideoWindow,
  moldura: ReturnType<typeof getMoldura>,
  molduraPath: string,
  outputPath: string
): Promise<void> {
  const filter = [
    scaleCropFilter(window, "0:v", "src"),
    `color=c=black:s=${moldura.canvasWidth}x${moldura.canvasHeight}[bg]`,
    `[bg][src]overlay=${window.x}:${window.y}[tmp1]`,
    `[tmp1][1:v]overlay=0:0,format=yuv420p[outv]`,
  ].join(";");

  const args = [
    "-y",
    "-i", sourceClip,
    "-i", molduraPath,
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "0:a?",
    "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    outputPath,
  ];

  await run("ffmpeg", args);
}

function buildAudioFilter(mode: "streamer" | "mesa" | "mix"): { filter: string; outLabel: string } {
  if (mode === "streamer") return { filter: `[0:a]anull[outa]`, outLabel: "[outa]" };
  if (mode === "mesa") return { filter: `[1:a]anull[outa]`, outLabel: "[outa]" };
  // mix: streamer mais alto, mesa de fundo (ambiente da mesa) bem mais baixo
  return {
    filter: `[0:a]volume=1.0[a0];[1:a]volume=0.25[a1];[a0][a1]amix=inputs=2:duration=longest[outa]`,
    outLabel: "[outa]",
  };
}
