import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuid } from "uuid";
import { runPipeline } from "./pipeline.js";
import { createJob, updateJob, appendLog, getJob } from "./lib/jobStore.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

const UPLOAD_DIR = path.resolve("data/uploads");
const OUTPUT_DIR = path.resolve("data/output");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(path.resolve("public")));
app.use("/clips", express.static(OUTPUT_DIR));

app.post(
  "/api/jobs",
  upload.fields([
    { name: "streamer", maxCount: 1 },
    { name: "mesa", maxCount: 1 },
    { name: "outro", maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const streamerFile = files?.streamer?.[0];
    const mesaFile = files?.mesa?.[0];
    const outroFile = files?.outro?.[0];
    const moldura = (req.body.moldura as "split" | "full") ?? "split";
    const maxClips = Number(req.body.maxClips ?? 8);

    if (!streamerFile && !mesaFile) {
      return res.status(400).json({ error: "Envie pelo menos um vídeo (streamer ou mesa)." });
    }
    if (moldura === "split" && (!streamerFile || !mesaFile)) {
      return res.status(400).json({ error: "A moldura 'split' precisa dos dois vídeos: streamer e mesa." });
    }

    const jobId = uuid();
    createJob(jobId);
    res.json({ jobId });

    const mode = streamerFile && mesaFile ? "dual" : streamerFile ? "single-streamer" : "single-mesa";

    updateJob(jobId, { status: "running" });
    try {
      const result = await runPipeline({
        mode,
        streamerPath: streamerFile?.path,
        mesaPath: mesaFile?.path,
        outroPath: outroFile?.path,
        moldura,
        maxClips,
        workDir: path.join("data/tmp", jobId),
        outDir: path.join(OUTPUT_DIR, jobId),
        onProgress: (msg) => appendLog(jobId, msg),
      });

      const clips = result.clips.map((c) => ({
        url: `/clips/${jobId}/${path.basename(c.outputPath)}`,
        reason: c.highlight.reason,
        startSec: c.highlight.startSec,
        endSec: c.highlight.endSec,
      }));

      updateJob(jobId, { status: "done", clips });
    } catch (err: any) {
      console.error(err);
      updateJob(jobId, { status: "error", error: err.message ?? String(err) });
    }
  }
);

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "job não encontrado" });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`spin-clipper rodando em http://localhost:${PORT}`);
});
