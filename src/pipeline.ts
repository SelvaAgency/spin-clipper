import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";

import { detectAudioCandidates } from "./lib/highlightDetect.js";
import {
  selectHighlights,
  type Highlight,
  type CandidateWithContext,
} from "./lib/selectHighlights.js";
import { transcribe, type Transcript, type TranscriptWord } from "./lib/transcribe.js";
import { syncAudio, isSyncReliable } from "./lib/sync.js";
import { composeMoldura, generateDebugFrame, generateCompositionPreviewPng } from "./lib/compose.js";
import { buildAssFile, burnCaptions, groupWordsSingleLine, detectProfanity, type CensoredWord } from "./lib/captions.js";
import { getMoldura } from "./lib/molduras.js";
import { appendOutro } from "./lib/outro.js";
import { run, probe } from "./lib/ffmpegUtils.js";
import { downloadVideo, type DownloadOptions } from "./lib/download.js";
import { detectCrop, extractPreviewFrame, type CropInfo } from "./lib/cropDetect.js";
import { detectSplitRegions, type Region } from "./lib/splitDetect.js";
import { generateCompilation } from "./lib/compilation.js";
import { extractFrameAsBase64 } from "./lib/frameExtract.js";
import { waitForApproval } from "./lib/approvalQueue.js";
import {
  updateJob,
  type ApprovalResponse,
  type CaptionGroup,
} from "./lib/jobStore.js";

export interface PipelineInput {
  jobId: string;
  mode: "single-streamer" | "single-mesa" | "dual" | "single-combined";
  streamerPath?: string;
  mesaPath?: string;
  combinedPath?: string;
  outroPath?: string;
  urlLink?: string;
  urlStartSec?: number;
  urlEndSec?: number;
  moldura: "split" | "full";
  maxClips?: number;
  maxClipDurationSec?: number;
  padBeforeSec?: number;
  padAfterSec?: number;
  detectCropEnabled?: boolean;
  detectGameCropEnabled?: boolean;
  enableCaptions?: boolean;
  enableCensorship?: boolean;
  beepPaths?: string[];
  generateCompilationEnabled?: boolean;
  preferredGame?: "baccarat" | "blackjack" | "roulette" | "all";
  workDir: string;
  outDir: string;
  onProgress?: (msg: string) => void;
}

export interface PipelineResult {
  clips: Array<{ outputPath: string; highlight: Highlight }>;
  compilationPath?: string;
}

function formatAssTimeLog(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2).padStart(5, "0");
  return `${h}:${m.toString().padStart(2, "0")}:${s}`;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const log = input.onProgress ?? (() => {});
  fs.mkdirSync(input.workDir, { recursive: true });
  fs.mkdirSync(input.outDir, { recursive: true });

  const previewDir = path.join(input.outDir, "previews");
  fs.mkdirSync(previewDir, { recursive: true });

  // ─── 1. URL download ─────────────────────────────────────────────────────────
  if (input.urlLink) {
    log("Baixando vídeo do link fornecido...");
    const downloadPath = path.join(input.workDir, "downloaded.mp4");
    const dlOpts: DownloadOptions = { jobId: input.jobId };
    if (input.urlStartSec !== undefined) dlOpts.startSec = input.urlStartSec;
    if (input.urlEndSec   !== undefined) dlOpts.endSec   = input.urlEndSec;
    await downloadVideo(input.urlLink, downloadPath, log, dlOpts);
    if      (input.mode === "single-combined") (input as any).combinedPath  = downloadPath;
    else if (input.mode === "single-mesa")     (input as any).mesaPath      = downloadPath;
    else {
      (input as any).streamerPath = downloadPath;
      if (input.mode === "dual") (input as any).mesaPath = downloadPath;
    }
  }

  // ─── 2. Single-combined: detectar regiões e pedir layout ─────────────────────
  if (input.mode === "single-combined") {
    if (!input.combinedPath) throw new Error("Modo 'single-combined' precisa de combinedPath.");

    log("Detectando regiões de webcam e jogo no vídeo combinado...");
    const videoInfo = await probe(input.combinedPath);
    const regions   = await detectSplitRegions(input.combinedPath);

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
    let finalGame:   Region = regions.game;
    if (layoutResponse.adjustedData) {
      finalWebcam = layoutResponse.adjustedData.webcam ?? regions.webcam;
      finalGame   = layoutResponse.adjustedData.game   ?? regions.game;
    }

    log("Extraindo webcam e jogo do vídeo combinado...");
    const extractedStreamer = path.join(input.workDir, "extracted_webcam.mp4");
    const extractedMesa     = path.join(input.workDir, "extracted_game.mp4");

    await cropVideo(input.combinedPath, finalWebcam, extractedStreamer);
    await cropVideo(input.combinedPath, finalGame,   extractedMesa);

    (input as any).streamerPath = extractedStreamer;
    (input as any).mesaPath     = extractedMesa;
    (input as any).mode         = "dual";
    (input as any).moldura      = "split";
  }

  // ─── Variáveis de crop aprovadas ──────────────────────────────────────────────
  // IMUTÁVEIS após o loop de aprovação. Object.freeze() é aplicado ao sair.
  // Nenhum estágio posterior deve recalcular, substituir ou reinterpretar estes valores.
  let approvedStreamerCrop: CropInfo | undefined;
  let approvedMesaCrop:     CropInfo | undefined;

  // ─── 3. Determinar fontes de crop ─────────────────────────────────────────────
  //
  // BUG FIX: A condição original era `detectGameCropEnabled && mesaPath`.
  // Isso ignorava completamente a mesa quando o usuário usava uma fonte única
  // com moldura 'split' (URL ou arquivo único com webcam+jogo na mesma imagem).
  //
  // Nova lógica — gameCropSource é não-nulo em dois casos:
  //   (A) Modo dual explícito: detectGameCropEnabled=true E mesaPath definido
  //   (B) Split de fonte única: moldura=split E streamerPath definido E mesaPath ausente
  //
  const gameCropSource: string | null =
    (input.detectGameCropEnabled && input.mesaPath)
      ? input.mesaPath
      : (input.moldura === "split" && !!input.streamerPath && !input.mesaPath)
        ? input.streamerPath
        : null;

  // Caso B: definir mesaPath ANTES das detecções — simplifica todo o restante
  if (gameCropSource && !input.mesaPath) {
    (input as any).mesaPath = gameCropSource;
    log("Split de fonte única: mesmo vídeo usado para ambas as regiões (crop diferente).");
  }

  // Guarda de segurança: se split ainda não tiver mesaPath, forçar 'full'
  if (input.moldura === "split" && !input.mesaPath) {
    log("⚠️  Moldura 'split' sem vídeo de mesa — alternando para 'full' automaticamente.");
    (input as any).moldura = "full";
  }

  const wantsStreamerCrop = !!(input.detectCropEnabled && (input.streamerPath ?? input.mesaPath));
  const wantsGameCrop     = !!gameCropSource;

  // ─── 3a. Pré-detectar crops uma única vez (o loop de aprovação reutiliza) ─────
  type CropDetected = { cropInfo: CropInfo; videoW: number; videoH: number };
  let streamerCropData: CropDetected | null = null;
  let mesaCropData:     CropDetected | null = null;

  if (wantsStreamerCrop) {
    const t = input.streamerPath ?? input.mesaPath!;
    log("Detectando área útil do vídeo do streamer...");
    const [cropInfo, info] = await Promise.all([detectCrop(t), probe(t)]);
    streamerCropData = { cropInfo, videoW: info.width, videoH: info.height };
    await extractPreviewFrame(t, path.join(previewDir, "crop_preview.jpg"));
  }

  if (wantsGameCrop) {
    log("Detectando área útil do vídeo de mesa/jogo...");
    const [cropInfo, info] = await Promise.all([detectCrop(gameCropSource!), probe(gameCropSource!)]);
    mesaCropData = { cropInfo, videoW: info.width, videoH: info.height };
    await extractPreviewFrame(gameCropSource!, path.join(previewDir, "game_crop_preview.jpg"));
  }

  // ─── 3b. Loop de aprovação de crops + preview de composição ──────────────────
  //
  // Fluxo:
  //   1) Pede crop do streamer (se necessário)
  //   2) Pede crop da mesa (se necessário)
  //   3) Gera preview PNG da composição completa e aguarda aprovação
  //   4) Se "Ajustar Streamer" → volta ao passo 1; se "Ajustar Mesa" → volta ao 2
  //   5) Aprovado → Object.freeze() nos valores; pipeline continua
  //
  if (wantsStreamerCrop || wantsGameCrop) {
    let needStreamer = wantsStreamerCrop;
    let needMesa     = wantsGameCrop;

    while (true) {
      // — Crop do streamer —
      if (needStreamer && streamerCropData) {
        updateJob(input.jobId, {
          status: "waiting-crop-approval",
          pendingApproval: {
            type: "crop",
            data: {
              previewUrl: `/clips/${input.jobId}/previews/crop_preview.jpg`,
              detected: streamerCropData.cropInfo,
              videoW: streamerCropData.videoW,
              videoH: streamerCropData.videoH,
            },
          },
        });
        log("Aguardando confirmação do enquadramento do streamer...");
        const resp: ApprovalResponse = await waitForApproval(input.jobId);
        updateJob(input.jobId, { status: "running", pendingApproval: undefined });

        // Salvar no slot correto: se só existe mesa (modo single-mesa), vai para mesaCrop
        if (input.streamerPath) {
          approvedStreamerCrop = resp.adjustedData ? (resp.adjustedData as CropInfo) : undefined;
        } else {
          approvedMesaCrop = resp.adjustedData ? (resp.adjustedData as CropInfo) : undefined;
        }
        log("===== CROP APROVADO =====");
        if (approvedStreamerCrop) {
          log(`streamer  x:${approvedStreamerCrop.x} y:${approvedStreamerCrop.y} w:${approvedStreamerCrop.w} h:${approvedStreamerCrop.h}`);
        } else if (approvedMesaCrop && !input.streamerPath) {
          log(`mesa(single) x:${approvedMesaCrop.x} y:${approvedMesaCrop.y} w:${approvedMesaCrop.w} h:${approvedMesaCrop.h}`);
        } else {
          log("streamer  (frame completo — sem crop aplicado)");
        }
        needStreamer = false;
      }

      // — Crop da mesa/jogo —
      if (needMesa && mesaCropData) {
        updateJob(input.jobId, {
          status: "waiting-crop-approval",
          pendingApproval: {
            type: "crop",
            data: {
              previewUrl: `/clips/${input.jobId}/previews/game_crop_preview.jpg`,
              detected: mesaCropData.cropInfo,
              videoW: mesaCropData.videoW,
              videoH: mesaCropData.videoH,
              target: "game",
            },
          },
        });
        log("Aguardando confirmação do enquadramento da mesa/jogo...");
        const resp: ApprovalResponse = await waitForApproval(input.jobId);
        updateJob(input.jobId, { status: "running", pendingApproval: undefined });

        approvedMesaCrop = resp.adjustedData ? (resp.adjustedData as CropInfo) : undefined;
        log("===== CROP APROVADO =====");
        log(approvedMesaCrop
          ? `mesa      x:${approvedMesaCrop.x} y:${approvedMesaCrop.y} w:${approvedMesaCrop.w} h:${approvedMesaCrop.h}`
          : "mesa      (frame completo — sem crop aplicado)");
        needMesa = false;
      }

      // — Preview de composição: gera PNG e aguarda decisão do usuário —
      const currentMoldura = (input as any).moldura as PipelineInput["moldura"];
      const previewPngPath = path.join(previewDir, "composition_preview.png");

      try {
        log("Gerando pré-visualização da composição...");
        await generateCompositionPreviewPng({
          moldura:      currentMoldura,
          streamerPath: input.streamerPath,
          mesaPath:     input.mesaPath,
          streamerCrop: approvedStreamerCrop,
          mesaCrop:     approvedMesaCrop,
          previewTimeSec: 5,
          outputPath:   previewPngPath,
        });
      } catch (err: any) {
        log(`Aviso: preview de composição falhou — ${(err.message ?? "").split("\n")[0]}. Prosseguindo.`);
        break; // skip preview, continue pipeline
      }

      updateJob(input.jobId, {
        status: "waiting-composition-preview",
        pendingApproval: {
          type: "composition-preview",
          data: {
            previewUrl: `/clips/${input.jobId}/previews/composition_preview.png`,
            hasStreamer: !!input.streamerPath && wantsStreamerCrop,
            hasMesa:     !!input.mesaPath && wantsGameCrop,
          },
        },
      });
      log("Aguardando aprovação da pré-visualização...");
      const previewResp: ApprovalResponse = await waitForApproval(input.jobId);
      updateJob(input.jobId, { status: "running", pendingApproval: undefined });

      if (previewResp.approved) {
        log("Composição aprovada. Valores de crop congelados — iniciando renderização.");
        break;
      }

      const action = previewResp.adjustedData?.action as string | undefined;
      if (action === "adjust-streamer" && wantsStreamerCrop) {
        log("Ajustando enquadramento do streamer...");
        needStreamer = true;
      } else if (action === "adjust-mesa" && wantsGameCrop) {
        log("Ajustando enquadramento da mesa...");
        needMesa = true;
      } else {
        // Ação desconhecida → aprovar automaticamente
        log("Ação desconhecida no preview — aprovando automaticamente.");
        break;
      }
    }

    // GARANTIA DE IMUTABILIDADE: qualquer tentativa de modificar após este ponto
    // vai lançar TypeError (strict mode) ou falhar silenciosamente.
    if (approvedStreamerCrop) Object.freeze(approvedStreamerCrop);
    if (approvedMesaCrop)     Object.freeze(approvedMesaCrop);
  }

  // ─── 4. Sincronização (modo dual) ────────────────────────────────────────────
  let mesaOffsetSec = 0;
  const currentMode = (input as any).mode as PipelineInput["mode"];
  if (currentMode === "dual") {
    if (!input.streamerPath || !input.mesaPath) {
      throw new Error("Modo 'dual' precisa de streamerPath e mesaPath.");
    }
    log("Sincronizando áudio entre streamer e mesa...");
    const sync = await syncAudio(input.streamerPath, input.mesaPath);
    if (!isSyncReliable(sync)) {
      log(`Aviso: confiança da sincronização baixa (${sync.confidence.toFixed(2)}). Clipes podem sair levemente desalinhados.`);
    }
    mesaOffsetSec = sync.offsetSec;
    log(`Offset detectado: mesa está ${mesaOffsetSec.toFixed(2)}s em relação ao streamer.`);
  }

  // ─── 5. Detecção de candidatos por áudio ─────────────────────────────────────
  const analysisSource = input.streamerPath ?? input.mesaPath!;
  log("Procurando picos de reação no áudio...");
  const rawCandidates = await detectAudioCandidates(analysisSource);
  log(`${rawCandidates.length} candidatos de áudio encontrados.`);

  if (rawCandidates.length === 0) return { clips: [] };

  // Parâmetros de padding — calculados aqui para serem reutilizados nas etapas 6 e 7
  const maxDuration = input.maxClipDurationSec ?? 45;
  const padBefore   = input.padBeforeSec  ?? Math.min(Math.floor(maxDuration * 0.40), 30);
  const padAfter    = input.padAfterSec   ?? Math.min(Math.floor(maxDuration * 0.60), 40);

  // Limitar análise aos top-N por pico de áudio (reduz custo de API)
  const MAX_CANDIDATES_TO_ANALYZE = 20;
  const topCandidates = [...rawCandidates]
    .sort((a, b) => b.peakDb - a.peakDb)
    .slice(0, MAX_CANDIDATES_TO_ANALYZE);

  // ─── 6. Análise por candidato: transcrição + frame ───────────────────────────
  //
  // BUG FIX: O sistema transcrevia o vídeo COMPLETO (potencialmente 5 GB+).
  // Agora: extrai apenas o trecho de áudio de cada candidato (~60s) e transcreve
  // individualmente. Isso é ~100× menor por chamada e retorna timestamps
  // já 0-indexed relativos ao início do clipe — prontos para usar nas legendas.
  //
  const hasAssemblyAI = Boolean(process.env.ASSEMBLYAI_API_KEY);
  const hasAnthropic  = Boolean(process.env.ANTHROPIC_API_KEY);
  const needTranscripts = hasAssemblyAI && (input.enableCaptions || hasAnthropic);

  log(
    `Analisando ${topCandidates.length} candidatos` +
    (needTranscripts  ? " (transcrição por trecho)" : "") +
    (hasAnthropic     ? " + extração de frames"     : "") +
    "..."
  );

  // Processa em batches de 3 para não saturar o AssemblyAI
  const CONCURRENCY = 3;
  const candidateData: CandidateWithContext[] = new Array(topCandidates.length);

  async function analyzeCandidateBatch(indices: number[]): Promise<void> {
    await Promise.all(
      indices.map(async (i) => {
        const cand = topCandidates[i];
        const segStart  = Math.max(0, cand.centerSec - padBefore - 5); // +5s de margem
        const segDur    = padBefore + padAfter + 10;

        let transcript: Transcript | null = null;
        let frameBase64: string | null    = null;

        if (needTranscripts) {
          const audioPath = path.join(input.workDir, `cand_${i}_audio.mp3`);
          try {
            await extractAudioSegment(analysisSource, segStart, segDur, audioPath);
            transcript = await transcribe(audioPath);
            const preview = transcript.fullText.slice(0, 80);
            log(`  [${i + 1}/${topCandidates.length}] ${cand.centerSec.toFixed(0)}s — "${preview}${transcript.fullText.length > 80 ? "…" : ""}"`);
          } catch (err: any) {
            log(`  [${i + 1}] Transcrição falhou: ${err.message.split("\n")[0]}`);
          } finally {
            try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch { /* noop */ }
          }
        }

        if (hasAnthropic) {
          frameBase64 = await extractFrameAsBase64(
            analysisSource,
            cand.centerSec,
            input.workDir
          );
        }

        candidateData[i] = { candidate: cand, transcript, frameBase64 };
      })
    );
  }

  // Fatia em batches e aguarda cada lote antes de iniciar o próximo
  for (let start = 0; start < topCandidates.length; start += CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(CONCURRENCY, topCandidates.length - start) },
      (_, k) => start + k
    );
    await analyzeCandidateBatch(batch);
  }

  // ─── 7. Seleção multi-sinal de melhores momentos ─────────────────────────────
  //
  // BUG FIX: Antes usava apenas pico de áudio + snippet de texto de uma
  // transcrição global. Agora usa:
  //   • transcrição por candidato (0-indexed, pronta para legendas)
  //   • frame visual para análise de jogo/reação
  //   • prompt especializado em cassino
  //   • Claude Vision API quando disponível
  //
  log(`Selecionando melhores momentos (jogo=${input.preferredGame ?? "all"}, maxDur=${maxDuration}s)...`);
  const highlights = await selectHighlights(candidateData, {
    maxClips:           input.maxClips ?? 8,
    maxClipDurationSec: maxDuration,
    padBeforeSec:       padBefore,
    padAfterSec:        padAfter,
    preferredGame:      input.preferredGame,
  });

  log(`${highlights.length} momentos selecionados:`);
  highlights.forEach((h, i) =>
    log(
      `  [${i + 1}] ${h.startSec.toFixed(1)}s–${h.endSec.toFixed(1)}s` +
      ` (${(h.endSec - h.startSec).toFixed(1)}s)` +
      ` score=${h.score ?? "?"} fonte=${h.source} — ${h.reason}`
    )
  );

  // ─── 8. Corte + composição dos clipes ────────────────────────────────────────
  const composedClips: Array<{
    clipId: string;
    composedPath: string;
    finalPath: string;
    highlight: Highlight;
    words: TranscriptWord[];
  }> = [];

  const finalMoldura = (input as any).moldura as PipelineInput["moldura"];
  const debugDir = path.join(input.outDir, "debug");
  fs.mkdirSync(debugDir, { recursive: true });

  for (const [i, highlight] of highlights.entries()) {
    log(`Montando clipe ${i + 1}/${highlights.length} (${highlight.startSec.toFixed(1)}s – ${highlight.endSec.toFixed(1)}s)...`);
    const clipId   = uuid().slice(0, 8);
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

    // Garantia final: split sem mesaCut → erro descritivo
    if (finalMoldura === "split" && (!streamerCut || !mesaCut)) {
      throw new Error(
        `[clipe ${clipId}] Moldura 'split' requer os dois clipes, mas ` +
        `streamerCut=${!!streamerCut} mesaCut=${!!mesaCut}. ` +
        `Verifique se streamerPath e mesaPath estão definidos antes da composição.`
      );
    }

    // ── Frames de debug: original com retângulo vermelho sobre a área de crop ──
    const clipNum = String(i + 1).padStart(2, "0");
    if (approvedStreamerCrop && streamerCut) {
      const dbgPath = path.join(debugDir, `clip_${clipNum}_streamer.png`);
      try {
        await generateDebugFrame(streamerCut, duration / 2, approvedStreamerCrop, dbgPath);
        log(`  → Debug: debug/clip_${clipNum}_streamer.png`);
      } catch { /* non-blocking */ }
    }
    if (approvedMesaCrop && mesaCut) {
      const dbgPath = path.join(debugDir, `clip_${clipNum}_mesa.png`);
      try {
        await generateDebugFrame(mesaCut, duration / 2, approvedMesaCrop, dbgPath);
        log(`  → Debug: debug/clip_${clipNum}_mesa.png`);
      } catch { /* non-blocking */ }
    }

    log(`  → Compondo moldura '${finalMoldura}'...`);
    const composedPath = path.join(input.workDir, `${clipId}_composed.mp4`);
    await composeMoldura({
      moldura:      finalMoldura,
      streamerClip: streamerCut,
      mesaClip:     mesaCut,
      fullSource:   currentMode === "single-mesa" ? "mesa" : "streamer",
      outputPath:   composedPath,
      primaryAudio: currentMode === "dual" ? "mix" : "streamer",
      streamerCrop: approvedStreamerCrop,
      mesaCrop:     approvedMesaCrop,
    });
    const compSz = fs.existsSync(composedPath) ? Math.round(fs.statSync(composedPath).size / 1024) : 0;
    log(`  ✓ Composição concluída (${compSz} KB)`);

    // ── Realinhamento de legendas ────────────────────────────────────────────────
    //
    // PROBLEMA ORIGINAL: segStart = centerSec - padBefore - 5s (margem extra).
    // O transcript retornava palavras com PTS relativo a segStart, mas o clipe
    // começa em startSec = segStart + 5s → LAG DE ~5 SEGUNDOS nas legendas.
    //
    // SOLUÇÃO: re-transcrever o áudio do clipe já cortado (começa em t=0s).
    // AssemblyAI devolve timestamps 0..duration, garantindo sincronismo quadro-a-quadro.
    // Fallback: transcript original com offset corrigido aproximadamente.
    //
    let captionWords: TranscriptWord[] = [];

    if (input.enableCaptions && hasAssemblyAI) {
      // Fonte de áudio para realinhamento: streamer (voz mais clara) ou composto
      const audioSource = streamerCut ?? composedPath;
      const captionAudioPath = path.join(input.workDir, `${clipId}_legenda_audio.mp3`);

      log(`  → Realinhamento de legendas (t=0..${duration.toFixed(1)}s)...`);
      try {
        await extractAudioSegment(audioSource, 0, duration, captionAudioPath);
        const freshTranscript = await transcribe(captionAudioPath);
        captionWords = freshTranscript.words.filter(
          (w) => w.startSec >= 0 && w.startSec <= duration + 0.5
        );

        // ── Diagnóstico de timestamps ────────────────────────────────────────
        log(`  [legendas] ${captionWords.length} palavras realinhadas para clipe ${i + 1}`);
        const sample = captionWords.slice(0, 5);
        sample.forEach((w) =>
          log(`  [legendas]   "${w.text}" → ${w.startSec.toFixed(3)}s – ${w.endSec.toFixed(3)}s (ASS: ${formatAssTimeLog(w.startSec)})`)
        );

        if (highlight.transcript?.words?.length) {
          // Offset aproximado que causava o atraso antes da correção
          const approxOffset = Math.min(5, highlight.startSec);
          log(`  [legendas] comparação (offset original era ~${approxOffset.toFixed(1)}s):`);
          highlight.transcript.words.slice(0, 3).forEach((orig) => {
            const realigned = captionWords.find(
              (cw) => cw.text.toLowerCase() === orig.text.toLowerCase()
            );
            log(
              `  [legendas]   "${orig.text}"` +
              ` | antigo: ${orig.startSec.toFixed(3)}s (lag: +${approxOffset.toFixed(1)}s)` +
              ` | realinhado: ${(realigned?.startSec ?? NaN).toFixed(3)}s`
            );
          });
        }
      } catch (err: any) {
        log(`  [legendas] Realinhamento falhou: ${err.message.split("\n")[0]}`);
        // Fallback: transcript original com correção do offset de 5s
        const approxOffset = Math.min(5, highlight.startSec);
        captionWords = (highlight.transcript?.words ?? [])
          .map((w) => ({
            ...w,
            startSec: w.startSec - approxOffset,
            endSec:   w.endSec   - approxOffset,
          }))
          .filter((w) => w.startSec >= 0 && w.startSec <= duration + 0.5);
        log(`  [legendas] Fallback: ${captionWords.length} palavras com offset −${approxOffset.toFixed(1)}s`);
        captionWords.slice(0, 3).forEach((w) =>
          log(`  [legendas]   "${w.text}" → ${w.startSec.toFixed(3)}s (ASS: ${formatAssTimeLog(w.startSec)})`)
        );
      } finally {
        try { if (fs.existsSync(captionAudioPath)) fs.unlinkSync(captionAudioPath); } catch { /* noop */ }
      }
    }

    composedClips.push({ clipId, composedPath, finalPath: "", highlight, words: captionWords });
  }

  // ─── 9. Revisão e queima de legendas ─────────────────────────────────────────
  let captionsByClipId    = new Map<string, CaptionGroup[]>();
  let censoredByClipId    = new Map<string, CensoredWord[]>();
  const molduraConfig     = getMoldura(input.moldura);

  if (input.enableCaptions && composedClips.some((c) => c.words.length > 0)) {
    for (const c of composedClips) {
      const previewPath = path.join(input.outDir, `${c.clipId}_preview.mp4`);
      fs.copyFileSync(c.composedPath, previewPath);
    }

    const captionClips = composedClips.map((c) => {
      // Palavras já estão 0-indexed (relativas ao início do clipe).
      // groupWordsSingleLine garante uma linha por bloco, sem quebra de texto.
      const groups = groupWordsSingleLine(c.words).map((g, idx) => ({
        id:       `${c.clipId}_g${idx}`,
        text:     g.map((w) => w.text).join(" "),
        startSec: g[0].startSec,
        endSec:   g[g.length - 1].endSec,
      }));

      // Detecta palavrões para censura de áudio (independe da revisão do usuário)
      if (input.enableCensorship) {
        censoredByClipId.set(c.clipId, detectProfanity(c.words));
      }

      return {
        clipId:   c.clipId,
        clipUrl:  `/clips/${input.jobId}/${c.clipId}_preview.mp4`,
        startSec: c.highlight.startSec,
        endSec:   c.highlight.endSec,
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
      for (const c of captionClips) {
        captionsByClipId.set(c.clipId, c.groups);
      }
    }
  }

  // ─── 10. Outro + finalizar ────────────────────────────────────────────────────
  const finalClipPaths: string[] = [];

  for (const c of composedClips) {
    let currentPath = c.composedPath;

    if (input.enableCaptions && captionsByClipId.has(c.clipId)) {
      const groups = captionsByClipId.get(c.clipId)!;
      if (groups.length > 0) {
        const assPath       = path.join(input.workDir, `${c.clipId}.ass`);
        const captionedPath = path.join(input.workDir, `${c.clipId}_legendado.mp4`);

        // Grupos passados diretamente — sem re-split nem interpolação linear de timestamps
        const censoredWords = censoredByClipId.get(c.clipId) ?? [];
        buildAssFile(groups, molduraConfig, assPath, censoredWords);
        await burnCaptions(currentPath, assPath, captionedPath, {
          censoredWords,
          beepPaths: input.beepPaths,
        });
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

  // ─── 11. Compilação ───────────────────────────────────────────────────────────
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

// ─── Helpers internos ─────────────────────────────────────────────────────────

async function cutClip(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  outputPath: string
): Promise<void> {
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
): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-i", sourcePath,
    "-vf", `crop=${region.w}:${region.h}:${region.x}:${region.y}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-c:a", "aac",
    outputPath,
  ]);
}

/**
 * Extrai apenas a trilha de áudio de um trecho do vídeo fonte.
 * Usado para transcrição por candidato — evita enviar o vídeo inteiro para a API.
 * Saída: MP3 de ~60s (~2-3 MB) em vez de MP4 de horas (~GBs).
 */
async function extractAudioSegment(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  outputPath: string
): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-ss", String(Math.max(0, startSec)),
    "-i", sourcePath,
    "-t", String(Math.max(1, durationSec)),
    "-vn",                 // sem vídeo
    "-c:a", "libmp3lame",
    "-q:a", "5",           // ~130 kbps
    outputPath,
  ], 60_000);
}
