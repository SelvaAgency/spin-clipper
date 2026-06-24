import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { detectAudioCandidates } from "./lib/highlightDetect.js";
import { selectHighlights, type Highlight } from "./lib/selectHighlights.js";
import { transcribe, sliceTranscript, type Transcript } from "./lib/transcribe.js";
import { syncAudio, isSyncReliable } from "./lib/sync.js";
import { composeMoldura } from "./lib/compose.js";
import { buildAssFile, burnCaptions } from "./lib/captions.js";
import { appendOutro } from "./lib/outro.js";
import { run } from "./lib/ffmpegUtils.js";

export interface PipelineInput {
  /** Modo "single": um arquivo já tem as duas fontes lado a lado/sobrepostas (não fazemos split automático disso ainda — ver README). */
  /** Modo "dual": dois arquivos separados, streamer e mesa. */
  mode: "single-streamer" | "single-mesa" | "dual";
  streamerPath?: string;
  mesaPath?: string;
  outroPath?: string;
  moldura: "split" | "full";
  maxClips?: number;
  workDir: string;
  outDir: string;
  onProgress?: (msg: string) => void;
}

export interface PipelineResult {
  clips: Array<{ outputPath: string; highlight: Highlight }>;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const log = input.onProgress ?? (() => {});
  fs.mkdirSync(input.workDir, { recursive: true });
  fs.mkdirSync(input.outDir, { recursive: true });

  // 1. Sincronização (só relevante no modo dual, com duas fontes separadas)
  let mesaOffsetSec = 0;
  if (input.mode === "dual") {
    if (!input.streamerPath || !input.mesaPath) {
      throw new Error("Modo 'dual' precisa de streamerPath e mesaPath.");
    }
    log("Sincronizando áudio entre streamer e mesa...");
    const sync = await syncAudio(input.streamerPath, input.mesaPath);
    if (!isSyncReliable(sync)) {
      log(
        `Aviso: confiança da sincronização baixa (${sync.confidence.toFixed(2)}). ` +
          `Os clipes podem sair desalinhados — vale checar manualmente.`
      );
    }
    mesaOffsetSec = sync.offsetSec;
    log(`Offset detectado: mesa está ${mesaOffsetSec.toFixed(2)}s em relação ao streamer.`);
  }

  // 2. Detecção de candidatos (sempre a partir do áudio do streamer — é onde rolam as reações)
  const analysisSource = input.streamerPath ?? input.mesaPath!;
  log("Procurando picos de reação no áudio...");
  const candidates = await detectAudioCandidates(analysisSource);
  log(`${candidates.length} candidatos encontrados.`);

  if (candidates.length === 0) {
    return { clips: [] };
  }

  // 3. Transcrição (opcional — só roda se tiver ASSEMBLYAI_API_KEY)
  let transcript: Transcript | null = null;
  if (process.env.ASSEMBLYAI_API_KEY) {
    log("Transcrevendo áudio...");
    transcript = await transcribe(analysisSource);
  } else {
    log("ASSEMBLYAI_API_KEY não configurada — pulando transcrição (sem legenda, seleção só por áudio).");
  }

  // 4. Seleção dos melhores momentos (Claude confirma se ANTHROPIC_API_KEY estiver configurada)
  log("Selecionando os melhores momentos...");
  const highlights = await selectHighlights(candidates, transcript, { maxClips: input.maxClips ?? 8 });
  log(`${highlights.length} momentos selecionados.`);

  const clips: PipelineResult["clips"] = [];

  for (const [i, highlight] of highlights.entries()) {
    log(`Montando clipe ${i + 1}/${highlights.length} (${highlight.startSec.toFixed(1)}s a ${highlight.endSec.toFixed(1)}s)...`);
    const clipId = uuid().slice(0, 8);
    const duration = highlight.endSec - highlight.startSec;

    const streamerCut = input.streamerPath ? path.join(input.workDir, `${clipId}_streamer.mp4`) : undefined;
    const mesaCut = input.mesaPath ? path.join(input.workDir, `${clipId}_mesa.mp4`) : undefined;

    if (streamerCut) {
      await cutClip(input.streamerPath!, highlight.startSec, duration, streamerCut);
    }
    if (mesaCut) {
      // aplica o offset de sincronização achado no passo 1
      const mesaStart = highlight.startSec + mesaOffsetSec;
      await cutClip(input.mesaPath!, mesaStart, duration, mesaCut);
    }

    const composedPath = path.join(input.workDir, `${clipId}_composed.mp4`);
    await composeMoldura({
      moldura: input.moldura,
      streamerClip: streamerCut,
      mesaClip: mesaCut,
      fullSource: input.mode === "single-mesa" ? "mesa" : "streamer",
      outputPath: composedPath,
      primaryAudio: input.mode === "dual" ? "mix" : "streamer",
    });

    let captionedPath = composedPath;
    if (transcript) {
      const words = sliceTranscript(transcript, highlight.startSec, highlight.endSec);
      if (words.length > 0) {
        const assPath = path.join(input.workDir, `${clipId}.ass`);
        buildAssFile(words, highlight.startSec, assPath);
        captionedPath = path.join(input.workDir, `${clipId}_legendado.mp4`);
        await burnCaptions(composedPath, assPath, captionedPath);
      }
    }

    let finalPath = captionedPath;
    if (input.outroPath) {
      finalPath = path.join(input.outDir, `${clipId}_final.mp4`);
      await appendOutro(captionedPath, input.outroPath, finalPath);
    } else {
      finalPath = path.join(input.outDir, `${clipId}_final.mp4`);
      fs.copyFileSync(captionedPath, finalPath);
    }

    clips.push({ outputPath: finalPath, highlight });
  }

  return { clips };
}

async function cutClip(sourcePath: string, startSec: number, durationSec: number, outputPath: string) {
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
