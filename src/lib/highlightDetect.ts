import { run } from "./ffmpegUtils.js";

export interface AudioCandidate {
  /** segundos, relativo ao início do arquivo analisado */
  centerSec: number;
  /** RMS em dB no momento do pico (mais alto = reação mais forte) */
  peakDb: number;
}

export interface DetectOptions {
  /** tamanho da janela de análise, em segundos. Default 1s. */
  windowSec?: number;
  /** quão acima da média (em dB) um momento precisa estar pra contar como candidato. Default 6dB. */
  thresholdAboveMeanDb?: number;
  /** distância mínima entre dois picos, em segundos, pra não pegar o mesmo grito 3x. Default 15s. */
  minGapSec?: number;
}

/**
 * Usa o filtro `astats` do ffmpeg pra extrair RMS de áudio por janela de tempo,
 * depois acha os picos que se destacam da média (reações: grito, risada, comemoração).
 *
 * Isso é o "candidato rápido". A confirmação semântica (o que realmente é
 * interessante) fica pro selectHighlights.ts, que cruza isso com a transcrição.
 */
export async function detectAudioCandidates(
  filePath: string,
  opts: DetectOptions = {}
): Promise<AudioCandidate[]> {
  const windowSec = opts.windowSec ?? 1;
  const thresholdAboveMeanDb = opts.thresholdAboveMeanDb ?? 6;
  const minGapSec = opts.minGapSec ?? 15;

  // astats sozinho só imprime um resumo humano no stderr. Pra extrair os
  // valores por janela de tempo, precisa encadear com ametadata=mode=print,
  // que emite "lavfi.astats.Overall.RMS_level=<valor>" por frame no stdout.
  //
  // `reset` do astats é em número de FRAMES, não segundos — então a gente
  // força um sample rate conhecido e um tamanho de frame fixo (asetnsamples)
  // pra garantir que "reset=1" corresponda exatamente a `windowSec` segundos.
  const sampleRate = 16000;
  const samplesPerWindow = Math.round(sampleRate * windowSec);
  const { stdout } = await run("ffmpeg", [
    "-i", filePath,
    "-af",
    `aresample=${sampleRate},asetnsamples=n=${samplesPerWindow}:p=0,` +
      `astats=metadata=1:reset=1,ametadata=mode=print:file=-`,
    "-f", "null",
    "-",
  ]);

  const rmsRegex = /lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?)/g;
  const levels: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = rmsRegex.exec(stdout)) !== null) {
    const v = parseFloat(match[1]);
    if (Number.isFinite(v)) levels.push(v);
  }

  if (levels.length === 0) return [];

  const finiteLevels = levels.filter((v) => v > -90); // ignora silêncio digital puro
  const mean = finiteLevels.reduce((a, b) => a + b, 0) / Math.max(finiteLevels.length, 1);

  const rawPeaks: AudioCandidate[] = [];
  levels.forEach((db, i) => {
    if (db > mean + thresholdAboveMeanDb) {
      rawPeaks.push({ centerSec: i * windowSec, peakDb: db });
    }
  });

  // Reduz picos próximos a um só (o mais alto da vizinhança)
  const merged: AudioCandidate[] = [];
  for (const peak of rawPeaks.sort((a, b) => a.centerSec - b.centerSec)) {
    const last = merged[merged.length - 1];
    if (last && peak.centerSec - last.centerSec < minGapSec) {
      if (peak.peakDb > last.peakDb) merged[merged.length - 1] = peak;
    } else {
      merged.push(peak);
    }
  }

  return merged.sort((a, b) => b.peakDb - a.peakDb);
}
