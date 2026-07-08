import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, probe } from "../../lib/ffmpegUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "ai/analyze_product.py");

// ── Tipos públicos ─────────────────────────────────────────────────────────

export interface ScoredSegment {
  id: string;
  startSec: number;
  endSec: number;
  duration: number;
  score: number;
  motives: string[];
  penalties: string[];
  selected: boolean;
  metrics: {
    focus: number;
    stability: number;
    lighting: number;
    composition: number;
    interest: number;
  };
}

export interface BaeshAnalysisInput {
  jobId: string;
  videoPath: string;
  workDir: string;
  outDir: string;
  onProgress?: (msg: string) => void;
  targetSec?: number;   // duração desejada do vídeo final (default 45)
  minSegSec?: number;   // mínimo por trecho (default 1.5)
  maxSegSec?: number;   // máximo por trecho (default 8)
  sampleFps?: number;   // frames por segundo para análise (default 4)
}

export interface BaeshAnalysisResult {
  allSegments:        ScoredSegment[];
  selectedSegments:   ScoredSegment[];
  durationSec:        number;
  totalSelectedSec:   number;
  targetSec:          number;
}

export interface BaeshRenderInput {
  jobId: string;
  videoPath: string;
  selectedSegments: ScoredSegment[];
  workDir: string;
  outDir: string;
  onProgress?: (msg: string) => void;
}

export interface BaeshRenderResult {
  outputPath:      string;
  outputDurationSec: number;
  segmentCount:    number;
}

// ── Fase 1: Análise ────────────────────────────────────────────────────────

export async function runBaeshAnalysis(
  input: BaeshAnalysisInput
): Promise<BaeshAnalysisResult> {
  const log = input.onProgress ?? (() => {});
  fs.mkdirSync(input.workDir, { recursive: true });
  fs.mkdirSync(input.outDir,  { recursive: true });

  const targetSec = input.targetSec ?? 45;
  const minSegSec = input.minSegSec ?? 1.5;
  const maxSegSec = input.maxSegSec ?? 8.0;
  const sampleFps = input.sampleFps ?? 4;

  log(`Iniciando análise (duração alvo: ${targetSec}s, amostragem: ${sampleFps}fps)...`);

  const { stdout } = await run("python3", [
    SCRIPT,
    input.videoPath,
    "--fps",         String(sampleFps),
    "--target-sec",  String(targetSec),
    "--min-seg-sec", String(minSegSec),
    "--max-seg-sec", String(maxSegSec),
  ], 30 * 60_000);

  const raw = JSON.parse(stdout) as {
    segments:           ScoredSegment[];
    selected_segments:  ScoredSegment[];
    duration_sec:       number;
    total_selected_sec: number;
    target_sec:         number;
  };

  log(`Análise concluída: ${raw.segments.length} trechos avaliados, ${raw.selected_segments.length} selecionados (${raw.total_selected_sec.toFixed(1)}s)`);

  return {
    allSegments:      raw.segments,
    selectedSegments: raw.selected_segments,
    durationSec:      raw.duration_sec,
    totalSelectedSec: raw.total_selected_sec,
    targetSec:        raw.target_sec,
  };
}

// ── Fase 2: Renderização ───────────────────────────────────────────────────

export async function runBaeshRender(
  input: BaeshRenderInput
): Promise<BaeshRenderResult> {
  const log = input.onProgress ?? (() => {});
  fs.mkdirSync(input.workDir, { recursive: true });
  fs.mkdirSync(input.outDir,  { recursive: true });

  if (input.selectedSegments.length === 0) {
    throw new Error("Nenhum trecho selecionado para renderizar.");
  }

  const segs = [...input.selectedSegments].sort((a, b) => a.startSec - b.startSec);
  log(`Renderizando ${segs.length} trecho(s)...`);

  const segPaths: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const segPath = path.join(input.workDir, `seg_${String(i).padStart(4, "0")}.mp4`);
    log(`  [${i + 1}/${segs.length}] ${fmtSec(seg.startSec)} → ${fmtSec(seg.endSec)}  score ${seg.score}`);
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

  const listPath = path.join(input.workDir, "concat.txt");
  fs.writeFileSync(listPath, segPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

  const outputPath = path.join(input.outDir, "baesh_output.mp4");
  log("Unindo trechos...");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath]);

  const info = await probe(outputPath);
  log(`Concluído! Vídeo final: ${info.durationSec.toFixed(1)}s`);

  return { outputPath, outputDurationSec: info.durationSec, segmentCount: segs.length };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
