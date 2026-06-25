import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuid } from "uuid";
import { runPipeline, type PipelineInput } from "./pipeline.js";
import { createJob, updateJob, appendLog, getJob } from "./lib/jobStore.js";
import { submitApproval } from "./lib/approvalQueue.js";
import { saveFeedback, getAllFeedback, getFeedbackByJob, getFeedbackStats } from "./lib/feedbackStore.js";
import {
  createProfile, getProfile, listProfiles, updateProfile, deleteProfile,
} from "./lib/creatorProfile.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

const UPLOAD_DIR = path.resolve("data/uploads");
const OUTPUT_DIR = path.resolve("data/output");
const TMP_DIR    = path.resolve("data/tmp");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR,    { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

app.use(express.json());
app.use(express.static(path.resolve("public")));
app.use("/clips", express.static(OUTPUT_DIR));

// ─── POST /api/jobs ───────────────────────────────────────────────────────────
app.post(
  "/api/jobs",
  upload.fields([
    { name: "streamer", maxCount: 1 },
    { name: "mesa",     maxCount: 1 },
    { name: "combined", maxCount: 1 },
    { name: "outro",    maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const streamerFile = files?.streamer?.[0];
    const mesaFile     = files?.mesa?.[0];
    const combinedFile = files?.combined?.[0];
    const outroFile    = files?.outro?.[0];

    const moldura    = (req.body.moldura as "split" | "full") ?? "split";
    const maxClips   = Number(req.body.maxClips ?? 8);
    const urlLink    = req.body.urlLink?.trim() || undefined;
    const profileId  = req.body.profileId?.trim() || undefined;

    // Duração: quando pads não vêm do body (modo preset), ficam undefined
    // e selectHighlights.ts os deriva de maxClipDurationSec automaticamente.
    const maxClipDurationSec = req.body.maxClipDurationSec ? Number(req.body.maxClipDurationSec) : undefined;
    const padBeforeSec       = req.body.padBeforeSec       ? Number(req.body.padBeforeSec)       : undefined;
    const padAfterSec        = req.body.padAfterSec        ? Number(req.body.padAfterSec)        : undefined;

    const detectCropEnabled          = req.body.detectCrop         === "true";
    const enableCaptions             = req.body.enableCaptions     === "true";
    const generateCompilationEnabled = req.body.generateCompilation === "true";
    const detectGameCropEnabled      = req.body.detectGameCrop     === "true";

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

    const pipelineInput: PipelineInput = {
      jobId, mode,
      streamerPath: streamerFile?.path,
      mesaPath:     mesaFile?.path,
      combinedPath: combinedFile?.path,
      outroPath:    outroFile?.path,
      urlLink,
      moldura,
      maxClips,
      maxClipDurationSec,
      padBeforeSec,
      padAfterSec,
      detectCropEnabled,
      detectGameCropEnabled,
      enableCaptions,
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
      console.error(err);
      updateJob(jobId, { status: "error", error: err.message ?? String(err) });
    }
  }
);

// ─── GET /api/jobs/:id ────────────────────────────────────────────────────────
app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job não encontrado." });
  res.json(job);
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

  const { clipIndex, rating, edits } = req.body;
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

app.listen(PORT, () => {
  console.log(`spin-clipper rodando em http://localhost:${PORT}`);
});
