import fs from "node:fs";
import path from "node:path";
import { run, probe } from "../../src/lib/ffmpegUtils.js";

export interface BaeshInput {
  jobId: string;
  videoPath: string;
  workDir: string;
  outDir: string;
  onProgress?: (msg: string) => void;
  sensitivity?: number;   // 0–100, default 50
  minBlurSec?: number;    // default 0.5
  sampleFps?: number;     // default 2
}

export interface BlurSegment {
  startSec: number;
  endSec: number;
  avgScore: number;
  durationSec: number;
}

export interface BaeshResult {
  outputPath: string;
  removedSegments: BlurSegment[];
  keptSegments: Array<{ startSec: number; endSec: number }>;
  totalRemovedSec: number;
  originalDurationSec: number;
  outputDurationSec: number;
}

export async function runBaeshPipeline(input: BaeshInput): Promise<BaeshResult> {
  const log = input.onProgress ?? (() => {});
  fs.mkdirSync(input.workDir, { recursive: true });
  fs.mkdirSync(input.outDir, { recursive: true });

  // sensitivity 0..100 → threshold: high sensitivity = low threshold
  const sensitivity  = Math.max(0, Math.min(100, input.sensitivity ?? 50));
  const threshold    = Math.round(200 - (sensitivity / 100) * 180);
  const sampleFps    = input.sampleFps  ?? 2;
  const minBlurSec   = input.minBlurSec ?? 0.5;
  const scriptPath   = path.resolve("clients/baesh/ai/blur_detect.py");

  log(`Analisando desfoque (sensibilidade=${sensitivity}, limiar=${threshold}, amostragem=${sampleFps}fps)...`);

  const { stdout } = await run("python3", [
    scriptPath,
    input.videoPath,
    "--fps",          String(sampleFps),
    "--threshold",    String(threshold),
    "--min-blur-sec", String(minBlurSec),
    "--window",       "5",
  ], 20 * 60_000);

  const detected: { blurry_segments: any[]; all_scores: any[] } = JSON.parse(stdout);
  const removedSegments: BlurSegment[] = detected.blurry_segments.map((s: any) => ({
    startSec:   s.start_sec,
    endSec:     s.end_sec,
    avgScore:   s.avg_score ?? 0,
    durationSec: s.duration_sec ?? (s.end_sec - s.start_sec),
  }));

  log(`Detecção concluída: ${removedSegments.length} trecho(s) desfocado(s)`);

  const videoInfo = await probe(input.videoPath);
  const totalDuration = videoInfo.durationSec;

  if (removedSegments.length === 0) {
    log("Nenhum desfoque encontrado. Copiando vídeo original...");
    const outputPath = path.join(input.outDir, "baesh_output.mp4");
    fs.copyFileSync(input.videoPath, outputPath);
    return { outputPath, removedSegments: [], keptSegments: [{ startSec: 0, endSec: totalDuration }], totalRemovedSec: 0, originalDurationSec: totalDuration, outputDurationSec: totalDuration };
  }

  for (const seg of removedSegments) {
    log(`  Desfocado: ${seg.startSec.toFixed(2)}s → ${seg.endSec.toFixed(2)}s (${seg.durationSec.toFixed(2)}s, score=${seg.avgScore.toFixed(1)})`);
  }

  // Build clean segments
  const keptSegments: Array<{ startSec: number; endSec: number }> = [];
  let cursor = 0;
  for (const blur of removedSegments) {
    const blurStart = Math.max(0, blur.startSec - 0.05);
    const blurEnd   = Math.min(totalDuration, blur.endSec + 0.05);
    if (blurStart - cursor > 0.25) {
      keptSegments.push({ startSec: cursor, endSec: blurStart });
    }
    cursor = blurEnd;
  }
  if (totalDuration - cursor > 0.25) {
    keptSegments.push({ startSec: cursor, endSec: totalDuration });
  }

  if (keptSegments.length === 0) throw new Error("Vídeo inteiro desfocado — sem segmento limpo para exportar.");

  log(`Extraindo ${keptSegments.length} segmento(s) limpo(s)...`);

  // Extract each clean segment (re-encode for frame-accurate cuts)
  const segPaths: string[] = [];
  for (let i = 0; i < keptSegments.length; i++) {
    const seg = keptSegments[i];
    const segPath = path.join(input.workDir, `seg_${String(i).padStart(4, "0")}.mp4`);
    log(`  Segmento ${i + 1}/${keptSegments.length}: ${seg.startSec.toFixed(2)}s – ${seg.endSec.toFixed(2)}s`);
    await run("ffmpeg", [
      "-y",
      "-ss", String(seg.startSec),
      "-to", String(seg.endSec),
      "-i", input.videoPath,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      segPath,
    ]);
    segPaths.push(segPath);
  }

  // Concat
  const listPath = path.join(input.workDir, "concat.txt");
  fs.writeFileSync(listPath, segPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

  const outputPath = path.join(input.outDir, "baesh_output.mp4");
  log("Unindo segmentos...");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);

  const outInfo = await probe(outputPath);
  const totalRemovedSec = removedSegments.reduce((s, r) => s + r.durationSec, 0);
  log(`Concluído! Removido ${totalRemovedSec.toFixed(1)}s. Duração final: ${outInfo.durationSec.toFixed(1)}s`);

  return { outputPath, removedSegments, keptSegments, totalRemovedSec, originalDurationSec: totalDuration, outputDurationSec: outInfo.durationSec };
}
