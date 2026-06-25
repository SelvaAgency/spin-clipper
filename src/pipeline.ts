import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";

import { detectAudioCandidates } from "./lib/highlightDetect.js";
import { selectHighlights, type Highlight } from "./lib/selectHighlights.js";
import { transcribe, sliceTranscript, type Transcript, type TranscriptWord } from "./lib/transcribe.js";
import { syncAudio, isSyncReliable } from "./lib/sync.js";
import { composeMoldura } from "./lib/compose.js";
import { buildAssFile, burnCaptions, groupWords } from "./lib/captions.js";
import { appendOutro } from "./lib/outro.js";
import { run, probe } from "./lib/ffmpegUtils.js";
import { downloadVideo } from "./lib/download.js";
import { detectCrop, extractPreviewFrame, type CropInfo } from "./lib/cropDetect.js";
import { detectSplitRegions, type Region } from "./lib/splitDetect.js";
import { generateCompilation } from "./lib/compilation.js";
import { waitForApproval } from "./lib/approvalQueue.js";
import {
  updateJob,
  type ApprovalResponse,
  type CaptionGroup,
} from "./lib/jobStore.js";

export interface PipelineInput {
  jobId: string;
  /** "single-streamer": one file used as streamer source */
  /** "single-mesa": one file used as mesa source */
  /** "dual": two separate files (streamer + mesa) */
  /** "single-combined": one file containing both webcam overlay + game */
  mode: "single-streamer" | "single-mesa" | "dual" | "single-combined";
  streamerPath?: string;
  mesaPath?: string;
  /** Path to a single combined video (webcam + game in one file) */
  combinedPath?: string;
  outroPath?: string;
  /** URL to download video from (yt-dlp or direct HTTP) */
  urlLink?: string;
  moldura: "split" | "full";
  maxClips?: number;
  /** Max duration of each generated clip in seconds (default 45) */
  maxClipDurationSec?: number;
  /** Seconds of context before the audio peak (default 8) */
  padBeforeSec?: number;
  /** Seconds of context after the audio peak (default 6) */
  padAfterSec?: number;
  /** Auto-detect and ask user to approve crop region */
  detectCropEnabled?: boolean;
  /** Enable automatic captions + editor */
  enableCaptions?: boolean;
  /** Generate a single compilation video after individual clips */
  generateCompilationEnabled?: boolean;
  workDir: string;
  outDir: string;
  onProgress?: (msg: string) => void;
}

export interface PipelineResult {
  clips: Array<{ outputPath: string; highlight: Highlight }>;
  compilationPath?: string;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const log = input.onProgress ?? (() => {});
  fs.mkdirSync(input.workDir, { recursive: true });
  fs.mkdirSync(input.outDir, { recursive: true });

  const previewDir = path.join(input.outDir, "previews");
  fs.mkdirSync(previewDir, { recursive: true });

  // ─── 1. URL download ────────────────────────────────────────────────────────
  if (input.urlLink) {
    log("Baixando vídeo do link fornecido...");
    const downloadPath = path.join(input.workDir, "downloaded.mp4");
    await downloadVideo(input.urlLink, downloadPath, log);
    // Assign to appropriate field based on mode
    if (input.mode === "single-combined") {
      (input as any).combinedPath = downloadPath;
    } else if (input.mode === "single-mesa") {
      (input as any).mesaPath = downloadPath;
    } else {
      (input as any).streamerPath = downloadPath;
      if (input.mode === "dual") (input as any).mesaPath = downloadPath;
    }
  }

  // ─── 2. Single combined video: detect webcam + game regions ─────────────────
  if (input.mode === "single-combined") {
    if (!input.combinedPath) throw new Error("Modo 'single-combined' precisa de combinedPath.");

    log("Detectando regiões de webcam e jogo no vídeo combinado...");
    const videoInfo = await probe(input.combinedPath);
    const regions = await detectSplitRegions(input.combinedPath);

    const previewFramePath = path.join(previewDir, "layout_preview.jpg");
    await extractPreviewFrame(input.combinedPath, previewFramePath);

    updateJob(input.jobId, {
      status: "waiting-layout-approval",
      pendingApproval: {
        type: "layout",
        data: {
          previewUrl: `/clips/${input.jobId}/previews/layout_preview.jpg`,
          webcam: regions.webcam,
          game: regions.game,
          videoW: videoInfo.width,
          videoH: videoInfo.height,
        },
      },
    });
    log("Aguardando confirmação do enquadramento...");

    const layoutResponse: ApprovalResponse = await waitForApproval(input.jobId);
    updateJob(input.jobId, { status: "running", pendingApproval: undefined });

    let finalWebcam: Region = regions.webcam;
    let finalGame: Region = regions.game;

    if (layoutResponse.adjustedData) {
      finalWebcam = layoutResponse.adjustedData.webcam ?? regions.webcam;
      finalGame = layoutResponse.adjustedData.game ?? regions.game;
    }

    log("Extraindo webcam e jogo do vídeo combinado...");
    const extractedStreamer = path.join(input.workDir, "extracted_webcam.mp4");
    const extractedMesa = path.join(input.workDir, "extracted_game.mp4");

    await cropVideo(input.combinedPath, finalWebcam, extractedStreamer);
    await cropVideo(input.combinedPath, finalGame, extractedMesa);

    (input as any).streamerPath = extractedStreamer;
    (input as any).mesaPath = extractedMesa;
    (input as any).mode = "dual";
    (input as any).moldura = "split";
  }

  // ─── 3. Crop detection ───────────────────────────────────────────────────────
  if (input.detectCropEnabled) {
    const targetPath = input.streamerPath ?? input.mesaPath;
    if (targetPath) {
      log("Detectando área útil do vídeo...");
      const cropInfo = await detectCrop(targetPath);
      const videoInfo = await probe(targetPath);

      const previewFramePath = path.join(previewDir, "crop_preview.jpg");
      await extractPreviewFrame(targetPath, previewFramePath);

      updateJob(input.jobId, {
        status: "waiting-crop-approval",
        pendingApproval: {
          type: "crop",
          data: {
            previewUrl: `/clips/${input.jobId}/previews/crop_preview.jpg`,
            detected: cropInfo,
            videoW: videoInfo.width,
            videoH: videoInfo.height,
          },
        },
      });
      log("Aguardando confirmação do crop...");

      const cropResponse: ApprovalResponse = await waitForApproval(input.jobId);
      updateJob(input.jobId, { status: "running", pendingApproval: undefined });

      const finalCrop: CropInfo = cropResponse.adjustedData ?? cropInfo;

      const isFullFrame =
        finalCrop.x === 0 &&
        finalCrop.y === 0 &&
        finalCrop.w === videoInfo.width &&
        finalCrop.h === videoInfo.height;

      if (!isFullFrame) {
        log(`Aplicando crop: ${finalCrop.w}x${finalCrop.h} em ${finalCrop.x},${finalCrop.y}...`);
        if (input.streamerPath) {
          const croppedPath = path.join(input.workDir, "streamer_cropped.mp4");
          await cropVideo(input.streamerPath, finalCrop, croppedPath);
          (input as any).streamerPath = croppedPath;
        }
        if (input.mesaPath) {
          const croppedPath = path.join(input.workDir, "mesa_cropped.mp4");
          await cropVideo(input.mesaPath, finalCrop, croppedPath);
          (input as any).mesaPath = croppedPath;
        }
      }
    }
  }

  // ─── 4. Synchronization (dual mode) ─────────────────────────────────────────
  let mesaOffsetSec = 0;
  if ((input as any).mode === "dual") {
    if (!input.streamerPath || !input.mesaPath) {
      throw new Error("Modo 'dual' precisa de streamerPath e mesaPath.");
    }
    log("Sincronizando áudio entre streamer e mesa...");
    const sync = await syncAudio(input.streamerPath, input.mesaPath);
    if (!isSyncReliable(sync)) {
      log(
        `Aviso: confiança da sincronização baixa (${sync.confidence.toFixed(2)}). ` +
          `Os clipes podem sair desalinhados.`
      );
    }
    mesaOffsetSec = sync.offsetSec;
    log(`Offset detectado: mesa está ${mesaOffsetSec.toFixed(2)}s em relação ao streamer.`);
  }

  // ─── 5. Audio peak detection ─────────────────────────────────────────────────
  const analysisSource = input.streamerPath ?? input.mesaPath!;
  log("Procurando picos de reação no áudio...");
  const candidates = await detectAudioCandidates(analysisSource);
  log(`${candidates.length} candidatos encontrados.`);

  if (candidates.length === 0) return { clips: [] };

  // ─── 6. Transcription ────────────────────────────────────────────────────────
  let transcript: Transcript | null = null;
  if (process.env.ASSEMBLYAI_API_KEY && (input.enableCaptions || true)) {
    log("Transcrevendo áudio...");
    try {
      transcript = await transcribe(analysisSource);
      log("Transcrição concluída.");
    } catch (err: any) {
      log(`Transcrição falhou: ${err.message}. Continuando sem legenda.`);
    }
  } else {
    log("ASSEMBLYAI_API_KEY não configurada — sem transcrição.");
  }

  // ─── 7. Highlight selection ──────────────────────────────────────────────────
  log("Selecionando os melhores momentos...");
  const highlights = await selectHighlights(candidates, transcript, {
    maxClips: input.maxClips ?? 8,
    maxClipDurationSec: input.maxClipDurationSec ?? 45,
    padBeforeSec: input.padBeforeSec ?? 8,
    padAfterSec: input.padAfterSec ?? 6,
  });
  log(`${highlights.length} momentos selecionados.`);

  // ─── 8. Clip cutting + composition ──────────────────────────────────────────
  const composedClips: Array<{
    clipId: string;
    composedPath: string;
    finalPath: string;
    highlight: Highlight;
    words: TranscriptWord[];
  }> = [];

  const currentMode = (input as any).mode as PipelineInput["mode"];

  for (const [i, highlight] of highlights.entries()) {
    log(`Montando clipe ${i + 1}/${highlights.length} (${highlight.startSec.toFixed(1)}s – ${highlight.endSec.toFixed(1)}s)...`);
    const clipId = uuid().slice(0, 8);
    const duration = highlight.endSec - highlight.startSec;

    const streamerCut = input.streamerPath
      ? path.join(input.workDir, `${clipId}_streamer.mp4`)
      : undefined;
    const mesaCut = input.mesaPath
      ? path.join(input.workDir, `${clipId}_mesa.mp4`)
      : undefined;

    if (streamerCut) {
      log(`  → Cortando streamer em ${highlight.startSec.toFixed(1)}s (${duration.toFixed(1)}s)...`);
      await cutClip(input.streamerPath!, highlight.startSec, duration, streamerCut);
      const sz = fs.existsSync(streamerCut) ? Math.round(fs.statSync(streamerCut).size / 1024) : 0;
      log(`  ✓ Streamer cortado (${sz} KB)`);
    }
    if (mesaCut) {
      const mesaStart = highlight.startSec + mesaOffsetSec;
      log(`  → Cortando mesa em ${mesaStart.toFixed(1)}s (${duration.toFixed(1)}s)...`);
      await cutClip(input.mesaPath!, mesaStart, duration, mesaCut);
      const sz = fs.existsSync(mesaCut) ? Math.round(fs.statSync(mesaCut).size / 1024) : 0;
      log(`  ✓ Mesa cortada (${sz} KB)`);
    }

    log(`  → Compondo moldura '${input.moldura}'...`);
    const composedPath = path.join(input.workDir, `${clipId}_composed.mp4`);
    await composeMoldura({
      moldura: input.moldura,
      streamerClip: streamerCut,
      mesaClip: mesaCut,
      fullSource: currentMode === "single-mesa" ? "mesa" : "streamer",
      outputPath: composedPath,
      primaryAudio: currentMode === "dual" ? "mix" : "streamer",
    });
    const compSz = fs.existsSync(composedPath) ? Math.round(fs.statSync(composedPath).size / 1024) : 0;
    log(`  ✓ Composição concluída (${compSz} KB)`);

    const words = transcript
      ? sliceTranscript(transcript, highlight.startSec, highlight.endSec)
      : [];

    composedClips.push({
      clipId,
      composedPath,
      finalPath: "",
      highlight,
      words,
    });
  }

  // ─── 9. Caption approval + burning ──────────────────────────────────────────
  let captionsByClipId = new Map<string, CaptionGroup[]>();

  if (input.enableCaptions && transcript) {
    // Copy composed clips to output dir so they're accessible for preview
    for (const c of composedClips) {
      const previewPath = path.join(input.outDir, `${c.clipId}_preview.mp4`);
      fs.copyFileSync(c.composedPath, previewPath);
    }

    const captionClips = composedClips.map((c) => {
      const relWords = c.words.map((w) => ({
        text: w.text,
        startSec: w.startSec - c.highlight.startSec,
        endSec: w.endSec - c.highlight.startSec,
      }));
      const groups = groupWords(relWords).map((g, idx) => ({
        id: `${c.clipId}_g${idx}`,
        text: g.map((w) => w.text).join(" "),
        startSec: g[0].startSec,
        endSec: g[g.length - 1].endSec,
      }));

      return {
        clipId: c.clipId,
        clipUrl: `/clips/${input.jobId}/${c.clipId}_preview.mp4`,
        startSec: c.highlight.startSec,
        endSec: c.highlight.endSec,
        groups,
      };
    });

    updateJob(input.jobId, {
      status: "waiting-captions-approval",
      pendingApproval: {
        type: "captions",
        data: { clips: captionClips },
      },
    });
    log("Aguardando revisão das legendas...");

    const captionsResponse: ApprovalResponse = await waitForApproval(input.jobId);
    updateJob(input.jobId, { status: "running", pendingApproval: undefined });

    if (captionsResponse.approved && captionsResponse.adjustedData?.clips) {
      for (const edited of captionsResponse.adjustedData.clips as Array<{
        clipId: string;
        groups: CaptionGroup[];
      }>) {
        captionsByClipId.set(edited.clipId, edited.groups);
      }
    } else if (captionsResponse.approved) {
      // Approved without edits: use auto-generated groups
      for (const c of captionClips) {
        captionsByClipId.set(c.clipId, c.groups);
      }
    }
  }

  // ─── 10. Outro + finalize ────────────────────────────────────────────────────
  const finalClipPaths: string[] = [];

  for (const c of composedClips) {
    let currentPath = c.composedPath;

    // Burn captions if enabled and approved
    if (input.enableCaptions && captionsByClipId.has(c.clipId)) {
      const groups = captionsByClipId.get(c.clipId)!;
      if (groups.length > 0) {
        const assPath = path.join(input.workDir, `${c.clipId}.ass`);
        const captionedPath = path.join(input.workDir, `${c.clipId}_legendado.mp4`);

        // Convert groups back to TranscriptWord format for buildAssFile
        const words = groups.flatMap((g) =>
          g.text.split(" ").map((word, i, arr) => ({
            text: word,
            startSec:
              g.startSec + ((g.endSec - g.startSec) / arr.length) * i,
            endSec:
              g.startSec + ((g.endSec - g.startSec) / arr.length) * (i + 1),
          }))
        );

        buildAssFile(words, 0, assPath);
        await burnCaptions(currentPath, assPath, captionedPath);
        currentPath = captionedPath;
      }
    }

    const finalPath = path.join(input.outDir, `${c.clipId}_final.mp4`);

    if (input.outroPath) {
      await appendOutro(currentPath, input.outroPath, finalPath);
    } else {
      fs.copyFileSync(currentPath, finalPath);
    }

    c.finalPath = finalPath;
    finalClipPaths.push(finalPath);
  }

  // ─── 11. Compilation ─────────────────────────────────────────────────────────
  let compilationPath: string | undefined;

  if (input.generateCompilationEnabled && finalClipPaths.length > 0) {
    log("Gerando vídeo compilado com todos os melhores momentos...");
    compilationPath = path.join(input.outDir, "compilacao_final.mp4");
    await generateCompilation(finalClipPaths, compilationPath);
    log("Compilação gerada.");
  }

  return {
    clips: composedClips.map((c) => ({ outputPath: c.finalPath, highlight: c.highlight })),
    compilationPath,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function cutClip(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  outputPath: string
) {
  await run("ffmpeg", [
    "-y",
    "-ss", String(Math.max(0, startSec)),
    "-i", sourcePath,
    "-t", String(durationSec),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-c:a", "aac",
    outputPath,
  ]);
}

async function cropVideo(
  sourcePath: string,
  region: { x: number; y: number; w: number; h: number },
  outputPath: string
) {
  await run("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-vf", `crop=${region.w}:${region.h}:${region.x}:${region.y}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-c:a", "aac",
    outputPath,
  ]);
}
