import path from "node:path";
import { run } from "./ffmpegUtils.js";

export interface SyncResult {
  /** segundos. positivo = arquivo B começa depois do arquivo A. */
  offsetSec: number;
  /** 0 a ~1+. abaixo de 0.15 é sinal de que a correlação não é confiável (sem áudio em comum). */
  confidence: number;
}

const SCRIPT_PATH = path.resolve("scripts/sync_audio.py");
const LOW_CONFIDENCE_THRESHOLD = 0.15;

/**
 * Descobre o deslocamento temporal entre dois arquivos (streamer x mesa) quando
 * eles vêm separados e sem timecode em comum, usando correlação de áudio.
 *
 * Se a confiança vier baixa, NÃO aplique o offset automaticamente — melhor
 * pedir confirmação manual (ex: na interface, deixar o usuário arrastar um
 * slider de "ajuste fino" vendo os dois vídeos lado a lado) do que arriscar
 * sincronizar errado.
 */
export async function syncAudio(fileA: string, fileB: string): Promise<SyncResult> {
  const { stdout } = await run("python3", [SCRIPT_PATH, fileA, fileB]);
  const result = JSON.parse(stdout.trim());
  if (result.error) {
    throw new Error(`Falha ao sincronizar: ${result.error}`);
  }
  return { offsetSec: result.offset_sec, confidence: result.confidence };
}

export function isSyncReliable(result: SyncResult): boolean {
  return result.confidence >= LOW_CONFIDENCE_THRESHOLD;
}
