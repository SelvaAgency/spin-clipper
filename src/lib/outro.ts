import { run, probe } from "./ffmpegUtils.js";

const CANVAS_W = 1080;
const CANVAS_H = 1920;

/**
 * Junta o clipe com a vinheta final (outro/end card). Reencoda os dois
 * pro mesmo formato antes de concatenar — concat demuxer exige streams
 * compatíveis, e a vinheta provavelmente tem fps/codec diferente do clipe.
 * Se algum dos dois não tiver áudio (comum em vinhetas só com logo), gera
 * uma trilha muda do tamanho certo em vez de quebrar o concat.
 */
export async function appendOutro(clipPath: string, outroPath: string, outputPath: string) {
  const [clipInfo, outroInfo] = await Promise.all([probe(clipPath), probe(outroPath)]);

  const inputs = ["-i", clipPath, "-i", outroPath];
  const extraInputs: string[] = [];
  let nextInputIndex = 2;
  let clipAudioLabel = "0:a";
  let outroAudioLabel = "1:a";

  if (!clipInfo.hasAudio) {
    extraInputs.push("-f", "lavfi", "-t", String(clipInfo.durationSec || 1), "-i", "anullsrc=r=44100:cl=stereo");
    clipAudioLabel = `${nextInputIndex}:a`;
    nextInputIndex++;
  }
  if (!outroInfo.hasAudio) {
    extraInputs.push("-f", "lavfi", "-t", String(outroInfo.durationSec || 1), "-i", "anullsrc=r=44100:cl=stereo");
    outroAudioLabel = `${nextInputIndex}:a`;
    nextInputIndex++;
  }

  const filter = [
    `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
      `pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0]`,
    `[1:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
      `pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1]`,
    `[${clipAudioLabel}]aresample=44100[a0]`,
    `[${outroAudioLabel}]aresample=44100[a1]`,
    `[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`,
  ].join(";");

  await run("ffmpeg", [
    "-y",
    ...inputs,
    ...extraInputs,
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    outputPath,
  ]);
}
