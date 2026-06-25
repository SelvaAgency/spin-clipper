import type { AudioCandidate } from "./highlightDetect.js";
import type { Transcript } from "./transcribe.js";
import { sliceTranscript } from "./transcribe.js";

export interface Highlight {
  startSec: number;
  endSec: number;
  reason: string;
  score?: number;
  source: "ia" | "audio";
}

export interface SelectOptions {
  maxClips?: number;
  padBeforeSec?: number;
  padAfterSec?: number;
  maxClipDurationSec?: number;
  /** Jogo preferido do criador, para calibrar o prompt */
  preferredGame?: "baccarat" | "blackjack" | "roulette" | "all";
}

function requireAnthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}

async function askClaudeToRank(
  candidates: Array<{ candidate: AudioCandidate; transcriptSnippet: string }>,
  maxClips: number,
  preferredGame: string
): Promise<Array<{ index: number; reason: string; score: number }>> {
  const apiKey = requireAnthropicKey();
  if (!apiKey) return [];

  const gameCtx =
    preferredGame === "baccarat"
      ? "foco em baccarat: carta natural, par, banker/player"
      : preferredGame === "blackjack"
      ? "foco em blackjack: blackjack natural, bust, 21, double-down"
      : preferredGame === "roulette"
      ? "foco em roleta: straight-up, 0, sequência de cor, vizinhos"
      : "cassino genérico: roleta, blackjack, baccarat";

  const prompt = [
    `Você escolhe os melhores momentos de uma live de cassino (${gameCtx}) para cortar em Reels.`,
    "",
    "CRITÉRIOS EM ORDEM DE PESO:",
    "  10 – Vitória improvável / jackpot / pagamento enorme",
    "   9 – Blackjack natural / baccarat raro / straight flush / 35:1",
    "   8 – Near-miss tenso (quase ganhou), apostou tudo",
    "   7 – Sequência de vitórias consecutivas ou virada dramática",
    "   6 – Reação forte CAUSADA pela jogada (susto, comemoração intensa)",
    "   5 – Tensão pré-resultado visivelmente alta",
    "   3 – Pico de áudio sem contexto claro de jogada",
    "   1 – Fala neutra, tosse, risada sem motivo",
    "",
    "Candidatos (tempo em segundos, pico RMS, transcrição ao redor):",
    ...candidates.map(
      (c, i) =>
        `[${i}] ${c.candidate.centerSec.toFixed(1)}s  pico:${c.candidate.peakDb.toFixed(1)}dB  fala:"${c.transcriptSnippet.slice(0, 200)}"`
    ),
    "",
    `Responda SOMENTE JSON puro (sem markdown), lista com até ${maxClips} itens, do melhor ao pior:`,
    `[{"index":0,"reason":"<motivo curto em pt-BR>","score":8.5}]`,
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.warn(`[selectHighlights] Claude falhou (${res.status}), usando fallback heurístico.`);
    return [];
  }

  const json = await res.json();
  const text = json.content?.find((b: any) => b.type === "text")?.text ?? "[]";
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    console.warn("[selectHighlights] JSON inválido da Claude, usando fallback heurístico.");
    return [];
  }
}

/**
 * Seleciona os melhores trechos do vídeo para virar clipe.
 *
 * FIX DE DURAÇÃO: quando padBeforeSec/padAfterSec não forem fornecidos
 * explicitamente, são derivados de maxClipDurationSec (40% antes / 60% depois)
 * para que o clipe gerado RESPEITE a duração escolhida pelo usuário.
 */
export async function selectHighlights(
  candidates: AudioCandidate[],
  transcript: Transcript | null,
  opts: SelectOptions = {}
): Promise<Highlight[]> {
  const maxClips = opts.maxClips ?? 8;
  const maxDuration = opts.maxClipDurationSec ?? 45;
  const preferredGame = opts.preferredGame ?? "all";

  // Quando o usuário escolhe um preset (ex: 60s) sem definir pads explícitos,
  // derivamos os pads do maxDuration para que o clipe REALMENTE seja 60s.
  // padBeforeSec e padAfterSec só chegam como números quando o usuário está
  // no modo "Personalizado" da UI e digitou valores manualmente.
  const padBefore = opts.padBeforeSec ?? Math.min(Math.floor(maxDuration * 0.40), 30);
  const padAfter  = opts.padAfterSec  ?? Math.min(Math.floor(maxDuration * 0.60), 40);

  console.log(
    `[selectHighlights] maxDuration=${maxDuration}s  padBefore=${padBefore}s  padAfter=${padAfter}s` +
    `  maxClips=${maxClips}  jogo=${preferredGame}`
  );

  if (candidates.length === 0) return [];

  const withSnippets = candidates.map((candidate) => {
    const snippet = transcript
      ? sliceTranscript(transcript, candidate.centerSec - 12, candidate.centerSec + 12)
          .map((w) => w.text)
          .join(" ")
      : "";
    return { candidate, transcriptSnippet: snippet };
  });

  const ranked = transcript ? await askClaudeToRank(withSnippets, maxClips, preferredGame) : [];

  let chosen: Array<{ candidate: AudioCandidate; reason: string; score: number; source: "ia" | "audio" }>;

  if (ranked.length > 0) {
    console.log(`[selectHighlights] Claude ranqueou ${ranked.length} momentos:`);
    ranked.forEach((r) => console.log(`  [${r.index}] score=${r.score}  reason="${r.reason}"`));

    chosen = ranked
      .map(({ index, reason, score }) => {
        const c = candidates[index];
        if (!c) return null;
        return { candidate: c, reason, score, source: "ia" as const };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  } else {
    console.log("[selectHighlights] Usando fallback por pico de áudio.");
    chosen = candidates.slice(0, maxClips).map((c, i) => ({
      candidate: c,
      reason: "Pico de reação de áudio",
      score: parseFloat((10 - i * 0.5).toFixed(1)),
      source: "audio" as const,
    }));
  }

  return chosen.map(({ candidate, reason, score, source }) => {
    const rawStart = candidate.centerSec - padBefore;
    const rawEnd   = candidate.centerSec + padAfter;
    const startSec = Math.max(0, rawStart);
    const endSec   = Math.min(rawEnd, startSec + maxDuration);
    const duration = endSec - startSec;

    console.log(
      `[selectHighlights] clipe: ${startSec.toFixed(1)}s–${endSec.toFixed(1)}s ` +
      `(${duration.toFixed(1)}s)  score=${score}  fonte=${source}  reason="${reason}"`
    );

    return { startSec, endSec, reason, score, source };
  });
}
