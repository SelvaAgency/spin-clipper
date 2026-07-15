import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuid } from "uuid";
import { runPipeline, type PipelineInput } from "./pipeline.js";
import { getVideoInfo, cancelDownload } from "./lib/download.js";
import { run } from "./lib/ffmpegUtils.js";
import { createJob, updateJob, appendLog, getJob, type JobStatus } from "./lib/jobStore.js";
import { submitApproval } from "./lib/approvalQueue.js";
import { saveFeedback, getAllFeedback, getFeedbackByJob, getFeedbackStats } from "./lib/feedbackStore.js";
import {
  createProfile, getProfile, listProfiles, updateProfile, deleteProfile,
} from "./lib/creatorProfile.js";
import {
  runBaeshAnalysis, runBaeshRender,
  type BaeshAnalysisInput, type ScoredSegment,
} from "./clients/baesh/pipeline.js";
import { saveBaeshFeedback } from "./lib/baeshFeedback.js";

// ── Helpers de verificação de dependências ────────────────────────────────────
async function checkExists(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, 10_000);
    return true;
  } catch {
    return false;
  }
}

async function checkDependency(
  label: string,
  cmd: string,
  args: string[]
): Promise<void> {
  try {
    await run(cmd, args, 10_000);
    console.log(`  ✓ ${label}`);
  } catch (err: any) {
    const missing = err.message.includes("não foi encontrado") || (err as NodeJS.ErrnoException).code === "ENOENT";
    if (missing) {
      console.log(`  ✗ ${label} — NÃO ENCONTRADO (instale antes de usar esta função)`);
    } else {
      // Saiu com código != 0 mas o binário existe (ex: ffmpeg -version no stdout, saída 0 ok)
      console.log(`  ✓ ${label}`);
    }
  }
}

async function printDependencies(): Promise<void> {
  console.log("\n  Dependências:");
  await checkDependency("ffmpeg",   "ffmpeg",   ["-version"]);
  await checkDependency("ffprobe",  "ffprobe",  ["-version"]);
  await checkDependency("yt-dlp",   "yt-dlp",   ["--version"]);
  await checkDependency("python3",  "python3",  ["--version"]);
  await checkDependency("numpy",    "python3",  ["-c", "import numpy"]);
  await checkDependency("scipy",    "python3",  ["-c", "import scipy"]);
  console.log("");
}

const app = express();
const PORT = process.env.PORT ?? 3000;

const UPLOAD_DIR  = path.resolve("data/uploads");
const OUTPUT_DIR  = path.resolve("data/output");
const TMP_DIR     = path.resolve("data/tmp");
const BEEP_DIR = path.resolve("assets/sfx");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR,    { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });
const baeshUpload = multer({ dest: UPLOAD_DIR });

app.use(express.json());
app.use(express.static(path.resolve("public")));
app.use("/clips", express.static(OUTPUT_DIR));

// ─── GET /api/defaults ────────────────────────────────────────────────────────
app.get("/api/defaults", (_req, res) => {
  const defaultOutroPath = path.resolve("assets/defaults/default_outro.mp4");
  const legacyPath       = path.resolve("assets/defaults/spin_final.mp4");
  res.json({ defaultOutro: fs.existsSync(defaultOutroPath) || fs.existsSync(legacyPath) });
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const [ffmpeg, ffprobe, python, ytDlp] = await Promise.all([
    checkExists("ffmpeg",  ["-version"]),
    checkExists("ffprobe", ["-version"]),
    checkExists("python3", ["--version"]),
    checkExists("yt-dlp",  ["--version"]),
  ]);
  res.json({ status: "ok", ffmpeg, ffprobe, python, ytDlp });
});

// ─── POST /api/jobs ───────────────────────────────────────────────────────────
app.post(
  "/api/jobs",
  upload.fields([
    { name: "streamer", maxCount: 1 },
    { name: "mesa",     maxCount: 1 },
    { name: "combined", maxCount: 1 },
    { name: "outro",    maxCount: 1 },
    { name: "beep",     maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const streamerFile = files?.streamer?.[0];
    const mesaFile     = files?.mesa?.[0];
    const combinedFile = files?.combined?.[0];
    const outroFile    = files?.outro?.[0];
    const beepFile     = files?.beep?.[0];

    const moldura    = (req.body.moldura as "split" | "full") ?? "split";
    const maxClips   = Number(req.body.maxClips ?? 8);
    const urlLink    = req.body.urlLink?.trim() || undefined;
    const profileId  = req.body.profileId?.trim() || undefined;

    // Download parcial de live: offsets em segundos
    const urlStartSec = req.body.urlStartSec ? Number(req.body.urlStartSec) : undefined;
    const urlEndSec   = req.body.urlEndSec   ? Number(req.body.urlEndSec)   : undefined;

    // Duração: quando pads não vêm do body (modo preset), ficam undefined
    // e selectHighlights.ts os deriva de maxClipDurationSec automaticamente.
    const maxClipDurationSec = req.body.maxClipDurationSec ? Number(req.body.maxClipDurationSec) : undefined;
    const padBeforeSec       = req.body.padBeforeSec       ? Number(req.body.padBeforeSec)       : undefined;
    const padAfterSec        = req.body.padAfterSec        ? Number(req.body.padAfterSec)        : undefined;

    const detectCropEnabled          = req.body.detectCrop         === "true";
    const enableCaptions             = req.body.enableCaptions     === "true";
    const enableCensorship           = req.body.enableCensorship   === "true";
    const generateCompilationEnabled = req.body.generateCompilation === "true";
    const detectGameCropEnabled      = req.body.detectGameCrop     === "true";
    const useDefaultOutro            = req.body.useDefaultOutro    === "true";

    // Beep: usa arquivo enviado ou escaneia assets/sfx/ por censura_casino*.{mp3,wav}
    let resolvedBeepPaths: string[] | undefined;
    if (beepFile?.path) {
      resolvedBeepPaths = [beepFile.path];
    } else if (enableCensorship && fs.existsSync(BEEP_DIR)) {
      const found = fs.readdirSync(BEEP_DIR)
        .filter((f) => /^censura_casino.*\.(mp3|wav|ogg|aac)$/i.test(f))
        .map((f) => path.join(BEEP_DIR, f))
        .sort();
      if (found.length > 0) resolvedBeepPaths = found;
    }

    // Lê preferências do perfil, se houver
    let preferredGame: PipelineInput["preferredGame"] = "all";
    if (profileId) {
      const prof = getProfile(profileId);
      if (prof) preferredGame = prof.preferredGame;
    }

    // Determina modo
    let mode: PipelineInput["mode"];
    if (req.body.mode === "single-combined" && (combinedFile || urlLink)) {
      mode = "single-combined";
    } else if (req.body.mode === "url" && urlLink) {
      mode = "single-streamer";
    } else if (streamerFile && mesaFile) {
      mode = "dual";
    } else if (streamerFile) {
      mode = "single-streamer";
    } else if (mesaFile) {
      mode = "single-mesa";
    } else if (urlLink) {
      mode = "single-streamer";
    } else if (combinedFile) {
      mode = "single-combined";
    } else {
      return res.status(400).json({ error: "Envie pelo menos um vídeo ou link." });
    }

    if (moldura === "split" && mode === "dual" && (!streamerFile || !mesaFile)) {
      return res.status(400).json({ error: "Moldura 'split' precisa de streamer e mesa." });
    }

    const jobId = uuid();
    createJob(jobId);
    if (profileId) updateJob(jobId, { profileId });
    res.json({ jobId });

    updateJob(jobId, { status: "running" });

    // Outro: usa o arquivo enviado; se ausente e toggle "usar padrão" ativo,
    // tenta default_outro.mp4 com fallback para spin_final.mp4 (nome legado).
    const _outroNew    = path.resolve("assets/defaults/default_outro.mp4");
    const _outroLegacy = path.resolve("assets/defaults/spin_final.mp4");
    const _outroDefault = fs.existsSync(_outroNew) ? _outroNew : fs.existsSync(_outroLegacy) ? _outroLegacy : undefined;
    const resolvedOutroPath = outroFile?.path
      ?? (useDefaultOutro && _outroDefault ? _outroDefault : undefined);

    const pipelineInput: PipelineInput = {
      jobId, mode,
      streamerPath: streamerFile?.path,
      mesaPath:     mesaFile?.path,
      combinedPath: combinedFile?.path,
      outroPath:    resolvedOutroPath,
      urlLink,
      urlStartSec,
      urlEndSec,
      moldura,
      maxClips,
      maxClipDurationSec,
      padBeforeSec,
      padAfterSec,
      detectCropEnabled,
      detectGameCropEnabled,
      enableCaptions,
      enableCensorship,
      beepPaths:   resolvedBeepPaths,
      generateCompilationEnabled,
      preferredGame,
      workDir:  path.join(TMP_DIR, jobId),
      outDir:   path.join(OUTPUT_DIR, jobId),
      onProgress: (msg) => appendLog(jobId, msg),
    };

    try {
      const result = await runPipeline(pipelineInput);

      const clips = result.clips.map((c, i) => ({
        url:      `/clips/${jobId}/${path.basename(c.outputPath)}`,
        reason:   c.highlight.reason,
        score:    c.highlight.score,
        startSec: c.highlight.startSec,
        endSec:   c.highlight.endSec,
        source:   c.highlight.source,
        moldura,
        mode,
      }));

      const compilationUrl = result.compilationPath
        ? `/clips/${jobId}/${path.basename(result.compilationPath)}`
        : undefined;

      updateJob(jobId, { status: "done", clips, compilationUrl });
    } catch (err: any) {
      const msg        = err.message ?? String(err);
      const cancelled  = msg.includes("cancelado");
      const curJob     = getJob(jobId);
      // Se o status já foi setado para "cancelled" pelo endpoint /cancel,
      // não sobrescreve com "error".
      if (!cancelled && curJob?.status !== "cancelled") {
        console.error(err);
        updateJob(jobId, { status: "error", error: msg });
      }
    }
  }
);

// ─── POST /api/clips/trim — Clip rápido: re-corta clipe existente ───────────
app.post("/api/clips/trim", async (req, res) => {
  const { jobId, clipIndex, trimStartSec, trimEndSec } = req.body;
  if (!jobId || clipIndex == null) return res.status(400).json({ error: "jobId e clipIndex são obrigatórios." });

  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });

  const clip = job.clips[Number(clipIndex)];
  if (!clip) return res.status(404).json({ error: "Clipe não encontrado." });

  // Resolve path from URL: /clips/{jobId}/{filename} → data/output/{jobId}/{filename}
  const clipFilename = path.basename(clip.url);
  const clipPath     = path.join(OUTPUT_DIR, jobId, clipFilename);
  if (!fs.existsSync(clipPath)) return res.status(404).json({ error: "Arquivo do clipe não encontrado no servidor." });

  const start = Number(trimStartSec ?? 0);
  const end   = Number(trimEndSec ?? 9999);
  if (isNaN(start) || isNaN(end) || end <= start) return res.status(400).json({ error: "Intervalo inválido." });

  const outName  = clipFilename.replace(/\.mp4$/, `_trim_${Date.now()}.mp4`);
  const outPath  = path.join(OUTPUT_DIR, jobId, outName);

  try {
    await run("ffmpeg", [
      "-ss", String(start),
      "-i", clipPath,
      "-t", String(end - start),
      "-c", "copy",
      "-y", outPath,
    ]);
    res.json({ url: `/clips/${jobId}/${outName}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/jobs/:id/replay-score ──────────────────────────────────────────
app.get("/api/jobs/:id/replay-score", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });
  if (!job.replayScore) return res.status(404).json({ error: "Replay Score não disponível para este job." });
  res.json(job.replayScore);
});

// ─── POST /api/clients/baesh/jobs — Fase 1: análise ─────────────────────────
app.post(
  "/api/clients/baesh/jobs",
  baeshUpload.single("video"),
  async (req, res) => {
    const videoFile = req.file;
    if (!videoFile) return res.status(400).json({ error: "Envie um arquivo de vídeo." });

    const targetSec = req.body.targetSec  ? Number(req.body.targetSec)  : 45;
    const minSegSec = req.body.minSegSec  ? Number(req.body.minSegSec)  : 1.5;
    const maxSegSec = req.body.maxSegSec  ? Number(req.body.maxSegSec)  : 8.0;
    const sampleFps = req.body.sampleFps  ? Number(req.body.sampleFps)  : 4;

    const jobId = uuid();
    createJob(jobId);
    updateJob(jobId, { status: "running", clientId: "baesh" });
    res.json({ jobId });

    // Copia o vídeo original para o outDir com nome fixo (necessário na fase de render)
    const outDir = path.join(OUTPUT_DIR, jobId);
    fs.mkdirSync(outDir, { recursive: true });
    const originalVideoPath = path.join(outDir, "original.mp4");
    fs.copyFileSync(videoFile.path, originalVideoPath);

    const analysisInput: BaeshAnalysisInput = {
      jobId,
      videoPath:  originalVideoPath,
      workDir:    path.join(TMP_DIR, jobId),
      outDir,
      onProgress: (msg) => appendLog(jobId, msg),
      targetSec, minSegSec, maxSegSec, sampleFps,
    };

    try {
      const result = await runBaeshAnalysis(analysisInput);
      updateJob(jobId, {
        status: "waiting-segment-approval",
        pendingApproval: {
          type: "segments",
          data: {
            originalVideoUrl: `/clips/${jobId}/original.mp4`,
            durationSec:      result.durationSec,
            allSegments:      result.allSegments,
            selectedSegments: result.selectedSegments,
            totalSelectedSec: result.totalSelectedSec,
            targetSec:        result.targetSec,
          },
        },
      });
    } catch (err: any) {
      console.error(err);
      updateJob(jobId, { status: "error", error: err.message ?? String(err) });
    }
  }
);

// ─── POST /api/clients/baesh/jobs/:id/render — Fase 2: renderização ──────────
app.post("/api/clients/baesh/jobs/:id/render", express.json(), async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });
  if (job.status !== "waiting-segment-approval") {
    return res.status(409).json({ error: "Job não está aguardando aprovação de trechos." });
  }

  const selectedSegments: ScoredSegment[] = req.body.selectedSegments;
  if (!Array.isArray(selectedSegments) || selectedSegments.length === 0) {
    return res.status(400).json({ error: "Selecione pelo menos um trecho." });
  }

  updateJob(req.params.id, { status: "rendering", pendingApproval: undefined });
  res.json({ ok: true });

  const jobId = req.params.id;
  const videoPath = path.join(OUTPUT_DIR, jobId, "original.mp4");

  try {
    const result = await runBaeshRender({
      jobId,
      videoPath,
      selectedSegments,
      workDir:    path.join(TMP_DIR, jobId, "render"),
      outDir:     path.join(OUTPUT_DIR, jobId),
      onProgress: (msg) => appendLog(jobId, msg),
    });

    updateJob(jobId, {
      status: "done",
      clips: [{
        url:      `/clips/${jobId}/${path.basename(result.outputPath)}`,
        reason:   `${result.segmentCount} trechos selecionados · ${result.outputDurationSec.toFixed(1)}s`,
        score:    100,
        startSec: 0,
        endSec:   result.outputDurationSec,
      }],
      clientResult: {
        outputDurationSec: result.outputDurationSec,
        segmentCount:      result.segmentCount,
        selectedSegments,
      },
    });
  } catch (err: any) {
    console.error(err);
    updateJob(jobId, { status: "error", error: err.message ?? String(err) });
  }
});

// ─── POST /api/clients/baesh/jobs/:id/segment-feedback ───────────────────────
app.post("/api/clients/baesh/jobs/:id/segment-feedback", express.json(), (req, res) => {
  const { segmentId, rating } = req.body;
  if (!segmentId || !rating) {
    return res.status(400).json({ error: "segmentId e rating são obrigatórios." });
  }
  saveBaeshFeedback({ jobId: req.params.id, segmentId, rating });
  res.json({ ok: true });
});

// ─── GET /api/video-info?url=... ─────────────────────────────────────────────
app.get("/api/video-info", async (req, res) => {
  const url = (req.query.url as string)?.trim();
  if (!url) return res.status(400).json({ error: "Parâmetro 'url' é obrigatório." });
  try {
    const info = await getVideoInfo(url);
    res.json(info);
  } catch (err: any) {
    res.status(422).json({ error: err.message ?? "Falha ao obter informações do vídeo." });
  }
});

// ─── GET /api/jobs/:id ────────────────────────────────────────────────────────
app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });
  res.json(job);
});

// ─── POST /api/jobs/:id/cancel ───────────────────────────────────────────────
app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });

  const terminal: JobStatus[] = ["done", "error", "cancelled"];
  if (terminal.includes(job.status as JobStatus)) {
    return res.status(409).json({ error: "Job já finalizado." });
  }

  updateJob(req.params.id, { status: "cancelled" });
  const killed = cancelDownload(req.params.id);
  res.json({ ok: true, killed });
});

// ─── POST /api/jobs/:id/approve ───────────────────────────────────────────────
app.post("/api/jobs/:id/approve", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });

  const { type, approved, adjustedData } = req.body;
  if (!type || approved === undefined) {
    return res.status(400).json({ error: "Campos 'type' e 'approved' são obrigatórios." });
  }

  const resolved = submitApproval(req.params.id, { type, approved, adjustedData });
  if (!resolved) {
    return res.status(409).json({ error: "Nenhuma aprovação pendente para este job." });
  }
  res.json({ ok: true });
});

// ─── POST /api/jobs/:id/feedback ──────────────────────────────────────────────
app.post("/api/jobs/:id/feedback", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });

  const { clipIndex, rating, edits, tags, comment } = req.body;
  if (clipIndex === undefined) {
    return res.status(400).json({ error: "clipIndex é obrigatório." });
  }

  const clip = job.clips[clipIndex];
  if (!clip) return res.status(404).json({ error: "Clipe não encontrado." });

  const fb = saveFeedback({
    jobId: req.params.id,
    clipIndex,
    clipUrl: clip.url,
    rating,
    tags: Array.isArray(tags) ? tags : undefined,
    comment: comment?.trim() || undefined,
    edits,
    metadata: {
      startSec:    clip.startSec,
      endSec:      clip.endSec,
      durationSec: clip.endSec - clip.startSec,
      reason:      clip.reason,
      score:       clip.score,
      source:      clip.source ?? "audio",
      moldura:     clip.moldura ?? "unknown",
      mode:        clip.mode ?? "unknown",
    },
  });

  res.json({ ok: true, id: fb.id });
});

// ─── GET /api/feedback ────────────────────────────────────────────────────────
app.get("/api/feedback", (_req, res) => {
  res.json({ stats: getFeedbackStats(), items: getAllFeedback() });
});

app.get("/api/feedback/:jobId", (req, res) => {
  res.json(getFeedbackByJob(req.params.jobId));
});

// ─── Creator profiles ─────────────────────────────────────────────────────────
app.get("/api/profiles", (_req, res) => res.json(listProfiles()));

app.post("/api/profiles", (req, res) => {
  const { name, preferredGame = "all", clipDurationSec = 45, audioSensitivity = 1, notes = "" } = req.body;
  if (!name) return res.status(400).json({ error: "name é obrigatório." });
  const profile = createProfile({ name, preferredGame, clipDurationSec, audioSensitivity, notes });
  res.json(profile);
});

app.put("/api/profiles/:id", (req, res) => {
  const updated = updateProfile(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: "Perfil não encontrado." });
  res.json(updated);
});

app.delete("/api/profiles/:id", (req, res) => {
  const ok = deleteProfile(req.params.id);
  if (!ok) return res.status(404).json({ error: "Perfil não encontrado." });
  res.json({ ok: true });
});

app.get("/api/clients", (_req, res) => {
  res.json([
    { id: "casino", name: "Clipper de Casino", description: "Highlights de jogos ao vivo: detecta reações, recorta, compõe moldura, legenda.", colors: { primary: "#7b4fd6", accent: "#e8418c" } },
    { id: "baesh",  name: "Baesh",             description: "Editor automático de vídeos de produto",                                          colors: { primary: "#00b894", accent: "#00cec9" } },
  ]);
});

app.listen(PORT, async () => {
  console.log(`\nclipper rodando em http://localhost:${PORT}`);
  await printDependencies();
  const beepCount = fs.existsSync(BEEP_DIR)
    ? fs.readdirSync(BEEP_DIR).filter((f) => /^censura_casino.*\.(mp3|wav|ogg|aac)$/i.test(f)).length
    : 0;
  if (beepCount > 0) {
    console.log(`  ✓ ${beepCount} arquivo(s) de beep em assets/sfx/`);
  } else {
    console.log("  ! nenhum censura_casino*.mp3/wav em assets/sfx/ — censura de áudio desativada");
  }
});
