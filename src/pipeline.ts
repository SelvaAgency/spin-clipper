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
import { downloadVideo, type DownloadOptions } from "./lib/download.js";
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
  /** Partial download: start offset in seconds */
  urlStartSec?: number;
  /** Partial download: end offset in seconds */
  urlEndSec?: number;
  moldura: "split" | "full";
  maxClips?: number;
  /** Max duration of each generated clip in seconds (default 45) */
  maxClipDurationSec?: number;
  /** Seconds of context before the audio peak (default 8) */
  padBeforeSec?: number;
  /** Seconds of context after the audio peak (default 6) */
  padAfterSec?: number;
  /** Auto-detect and ask user to approve crop region (streamer) */
  detectCropEnabled?: boolean;
  /** Detectar e pedir aprovação do crop do vídeo de mesa/jogo */
  detectGameCropEnabled?: boolean;
  /** Enable automatic captions + editor */
  enableCaptions?: boolean;
  /** Generate a single compilation video after individual clips */
  generateCompilationEnabled?: boolean;
  /** Jogo preferido para calibrar o scoring da IA */
  preferredGame?: "baccarat" | "blackjack" | "roulette" | "all";
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
    const dlOpts: DownloadOptions = {};
    if (input.urlStartSec !== undefined) dlOpts.startSec = input.urlStartSec;
    if (input.urlEndSec   !== undefined) dlOpts.endSec   = input.urlEndSec;
    await downloadVideo(input.urlLink, downloadPath, log, dlOpts);
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

  // Coordenadas de crop aprovadas pelo usuário. Nunca são recalculadas após aprovação.
  // São passadas diretamente ao composeMoldura para aplicação no filter_complex.
  let approvedStreamerCrop: CropInfo | undefined;
  let approvedMesaCrop: CropInfo | undefined;

  // ─── 3. Crop detection (streamer) ────────────────────────────────────────────
  // A IA sugere uma região — NÃO aplica o crop ainda.
  // O usuário vê o frame ORIGINAL, ajusta a caixa e aprova.
  // As coordenadas aprovadas são congeladas e usadas na renderização final.
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

      if (cropResponse.adjustedData) {
        // Salvar as coordenadas aprovadas — serão aplicadas na composição final.
        if (input.streamerPath) {
          approvedStreamerCrop = cropResponse.adjustedData as CropInfo;
          log(`Crop do streamer salvo: ${approvedStreamerCrop.w}x${approvedStreamerCrop.h} em ${approvedStreamerCrop.x},${approvedStreamerCrop.y}`);
        } else {
          approvedMesaCrop = cropResponse.adjustedData as CropInfo;
          log(`Crop salvo: ${approvedMesaCrop.w}x${approvedMesaCrop.h} em ${approvedMesaCrop.x},${approvedMesaCrop.y}`);
        }
      } else {
        log("Usando frame completo do vídeo.");
      }
    }
  }

  // ─── 4a. Game crop approval (modo dual: crop do vídeo de mesa) ──────────────
  // Mesma lógica: sugestão da IA → aprovação → coordenadas congeladas.
  if (input.detectGameCropEnabled && input.mesaPath) {
    log("Detectando área útil do vídeo de mesa/jogo...");
    const gameCropInfo = await detectCrop(input.mesaPath);
    const gameVideoInfo = await probe(input.mesaPath);

    const gamePreviewPath = path.join(previewDir, "game_crop_preview.jpg");
    await extractPreviewFrame(input.mesaPath, gamePreviewPath);

    updateJob(input.jobId, {
      status: "waiting-crop-approval",
      pendingApproval: {
        type: "crop",
        data: {
          previewUrl: `/clips/${input.jobId}/previews/game_crop_preview.jpg`,
          detected: gameCropInfo,
          videoW: gameVideoInfo.width,
          videoH: gameVideoInfo.height,
          target: "game",
        },
      },
    });
    log("Aguardando confirmação do crop do jogo...");

    const gameCropResponse: ApprovalResponse = await waitForApproval(input.jobId);
    updateJob(input.jobId, { status: "running", pendingApproval: undefined });

    if (gameCropResponse.adjustedData) {
      approvedMesaCrop = gameCropResponse.adjustedData as CropInfo;
      log(`Crop do jogo salvo: ${approvedMesaCrop.w}x${approvedMesaCrop.h} em ${approvedMesaCrop.x},${approvedMesaCrop.y}`);
    } else {
      log("Usando frame completo do jogo.");
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
  // Transcreve se ASSEMBLYAI_API_KEY estiver configurada E legendas estiverem ativadas,
  // OU se ANTHROPIC_API_KEY estiver configurada (precisamos do transcript para o scoring).
  let transcript: Transcript | null = null;
  const needTranscript = Boolean(
    (process.env.ASSEMBLYAI_API_KEY && input.enableCaptions) ||
    (process.env.ASSEMBLYAI_API_KEY && process.env.ANTHROPIC_API_KEY)
  );
  if (needTranscript) {
    log("Transcrevendo áudio...");
    try {
      transcript = await transcribe(analysisSource);
      log(`Transcrição concluída (${transcript.words.length} palavras).`);
    } catch (err: any) {
      log(`Transcrição falhou: ${err.message}. Continuando sem legenda.`);
    }
  } else {
    log("Transcrição desativada (sem ASSEMBLYAI_API_KEY ou legendas não ativadas).");
  }

  // ─── 7. Highlight selection ──────────────────────────────────────────────────
  log(`Selecionando melhores momentos (jogo=${input.preferredGame ?? "all"}, maxDur=${input.maxClipDurationSec ?? 45}s)...`);
  const highlights = await selectHighlights(candidates, transcript, {
    maxClips:          input.maxClips ?? 8,
    maxClipDurationSec: input.maxClipDurationSec,
    padBeforeSec:      input.padBeforeSec,
    padAfterSec:       input.padAfterSec,
    preferredGame:     input.preferredGame,
  });
  log(`${highlights.length} momentos selecionados:`);
  highlights.forEach((h, i) =>
    log(`  [${i + 1}] ${h.startSec.toFixed(1)}s–${h.endSec.toFixed(1)}s (${(h.endSec - h.startSec).toFixed(1)}s) score=${h.score ?? "?"} fonte=${h.source} — ${h.reason}`)
  );

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
      // Coordenadas aprovadas pelo usuário — aplicadas uma única vez aqui no filter_complex
      streamerCrop: approvedStreamerCrop,
      mesaCrop: approvedMesaCrop,
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
