import type { AudioCandidate } from "./highlightDetect.js";
import type { Transcript } from "./transcribe.js";
import { sliceTranscript } from "./transcribe.js";

export interface Highlight {
  startSec: number;
  endSec: number;
  reason: string;
  /** "ia" = confirmado pelo Claude, "audio" = só o pico de áudio, sem confirmação semântica */
  source: "ia" | "audio";
}

export interface SelectOptions {
  /** quantos clipes finais você quer extrair desse vídeo bruto */
  maxClips?: number;
  /** segundos de contexto antes/depois do pico, pra não cortar a piada na metade */
  padBeforeSec?: number;
  padAfterSec?: number;
  /** duração máxima de cada clipe final, em segundos */
  maxClipDurationSec?: number;
}

function requireAnthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}

async function askClaudeToRank(
  candidates: Array<{ candidate: AudioCandidate; transcriptSnippet: string }>,
  maxClips: number
): Promise<Array<{ index: number; reason: string }>> {
  const apiKey = requireAnthropicKey();
  if (!apiKey) return [];

  const prompt = [
    "Você está ajudando a escolher os melhores momentos de uma live de cassino (roleta/blackjack) pra cortar em Reels.",
    "Cada candidato abaixo é um pico de reação de áudio do streamer, com a fala transcrita ao redor daquele momento.",
    "Escolha os melhores, pensando em: reação genuína forte (susto, comemoração, indignação), virada de jogo, valor alto em jogo, ou frase engraçada/marcante.",
    "Ignore picos que são só ruído, tosse, ou fala neutra sem nada acontecendo.",
    "",
    "Candidatos:",
    ...candidates.map(
      (c, i) => `[${i}] ${c.candidate.centerSec.toFixed(1)}s (pico ${c.candidate.peakDb.toFixed(1)}dB): "${c.transcriptSnippet}"`
    ),
    "",
    `Responda em JSON puro (sem markdown, sem texto fora do JSON), uma lista com até ${maxClips} itens,`,
    `cada item: {"index": <número do candidato>, "reason": "<motivo curto em português>"}.`,
    "Ordene do melhor pro pior.",
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
    console.warn(`Chamada ao Claude falhou (${res.status}), caindo pro fallback heurístico.`);
    return [];
  }

  const json = await res.json();
  const text = json.content?.find((b: any) => b.type === "text")?.text ?? "[]";
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    console.warn("Resposta do Claude não veio em JSON válido, caindo pro fallback heurístico.");
    return [];
  }
}

/**
 * Decide quais trechos do vídeo bruto valem virar clipe.
 *
 * Fluxo: detectAudioCandidates já achou os picos (rápido, local, grátis).
 * Aqui a gente pega a transcrição ao redor de cada pico e manda pro Claude
 * confirmar/ranquear. Se ANTHROPIC_API_KEY não estiver configurada, cai pro
 * fallback: usa só os picos de áudio mais fortes, sem confirmação semântica.
 */
export async function selectHighlights(
  candidates: AudioCandidate[],
  transcript: Transcript | null,
  opts: SelectOptions = {}
): Promise<Highlight[]> {
  const maxClips = opts.maxClips ?? 8;
  const padBefore = opts.padBeforeSec ?? 8;
  const padAfter = opts.padAfterSec ?? 6;
  const maxDuration = opts.maxClipDurationSec ?? 45;

  if (candidates.length === 0) return [];

  const withSnippets = candidates.map((candidate) => {
    const snippet = transcript
      ? sliceTranscript(transcript, candidate.centerSec - 10, candidate.centerSec + 10)
          .map((w) => w.text)
          .join(" ")
      : "";
    return { candidate, transcriptSnippet: snippet };
  });

  const ranked = transcript ? await askClaudeToRank(withSnippets, maxClips) : [];

  let chosen: Array<{ candidate: AudioCandidate; reason: string; source: "ia" | "audio" }>;
  if (ranked.length > 0) {
    chosen = ranked
      .map(({ index, reason }) => {
        const c = candidates[index];
        if (!c) return null;
        return { candidate: c, reason, source: "ia" as const };
      })
      .filter((x): x is { candidate: AudioCandidate; reason: string; source: "ia" } => x !== null);
  } else {
    chosen = candidates
      .slice(0, maxClips)
      .map((c) => ({ candidate: c, reason: "Pico de reação de áudio (sem confirmação semântica)", source: "audio" as const }));
  }

  return chosen.map(({ candidate, reason, source }) => {
    const rawStart = candidate.centerSec - padBefore;
    const rawEnd = candidate.centerSec + padAfter;
    const startSec = Math.max(0, rawStart);
    const endSec = Math.min(rawEnd, startSec + maxDuration);
    return { startSec, endSec, reason, source };
  });
}
