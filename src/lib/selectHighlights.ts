import type { AudioCandidate } from "./highlightDetect.js";
import type { Transcript } from "./transcribe.js";

// ── Interfaces públicas ───────────────────────────────────────────────────────

/** Candidato com contexto multi-sinal extraído para o ranking. */
export interface CandidateWithContext {
  candidate: AudioCandidate;
  /** Transcrição do trecho de áudio do candidato (0-indexed relativo ao início do candidato). */
  transcript: Transcript | null;
  /** Frame base64 JPEG extraído no momento de pico. Null se ffmpeg ausente ou falhou. */
  frameBase64: string | null;
}

export interface Highlight {
  startSec: number;
  endSec: number;
  reason: string;
  score?: number;
  source: "ia" | "audio";
  /** Transcrição do candidato (timestamps 0-indexed relativos ao início do clipe). */
  transcript?: Transcript;
}

export interface SelectOptions {
  maxClips?: number;
  padBeforeSec?: number;
  padAfterSec?: number;
  maxClipDurationSec?: number;
  preferredGame?: "baccarat" | "blackjack" | "roulette" | "all";
}

// ── Ranking por Claude Vision ─────────────────────────────────────────────────

function buildGameContext(preferredGame: string): string {
  switch (preferredGame) {
    case "baccarat":
      return "baccarat ao vivo: carta natural 8/9, tie, par, streak de banker/player";
    case "blackjack":
      return "blackjack ao vivo: blackjack natural, bust, 21, double-down, split";
    case "roulette":
      return "roleta ao vivo: straight-up, número zero, vizinhos, sequência de cor, azar/sorte extrema";
    default:
      return "cassino online genérico: slots, baccarat, blackjack, roleta, crash, game shows";
  }
}

async function askClaudeToRank(
  candidates: CandidateWithContext[],
  maxClips: number,
  preferredGame: string
): Promise<Array<{ index: number; reason: string; score: number }>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const gameCtx = buildGameContext(preferredGame);
  const hasFrames = candidates.some(c => c.frameBase64 !== null);

  const systemText = [
    `Você é um especialista em conteúdo viral de cassino online (${gameCtx}) e editor de Reels/TikTok.`,
    `Analise os candidatos abaixo e escolha os ${maxClips} MELHORES momentos para clipes virais.`,
    "",
    "SINAIS A ANALISAR EM CADA CANDIDATO:",
    "",
    hasFrames
      ? [
          "1. VISUAL (frame da tela):",
          "   • Que jogo está visível? (baccarat, blackjack, roleta, crash, slots, game show)",
          "   • Resultado: vitória grande, derrota total, multiplicador alto, near-miss dramático?",
          "   • Números/valores na tela: ganho, multiplicador, saldo, aposta?",
          "   • Expressão facial do streamer: comemoração, choque, frustração, tensão?",
          "   • Dealer ou mesa visível com posição clara de jogo?",
        ].join("\n")
      : "1. VISUAL: sem frames disponíveis nesta sessão.",
    "",
    "2. TRANSCRIÇÃO (fala ao redor do pico de áudio):",
    "   • Palavras-chave: 'VAI', 'VEM', 'SIM', 'NÃO', 'CARALHO', 'GANHOU', 'PERDEU', 'JACKPOT'",
    "   • Menção a valores: 'R$1000', 'x100', '50x', 'tudo', 'bate'",
    "   • Velocidade: fala acelerada = tensão; silêncio dramático antes de um resultado",
    "   • Exclamações, gritos, choro de alegria ou frustração",
    "",
    "3. ÁUDIO (peakDb):",
    "   • Quanto mais alto, mais provável que seja uma reação intensa",
    "   • Baixo dB + boa transcrição/visual = ainda pode ser bom momento",
    "",
    "ESCALA DE SCORE (use decimais como 8.5, 7.0, etc.):",
    "10 — Vitória enorme / jackpot / crash em alta / payout > 50x + reação expressiva",
    " 9 — Blackjack natural / baccarat tie/par raro / near-miss extremo / perda total dramática",
    " 8 — Sequência de vitórias / virada súbita / apostou tudo e foi",
    " 7 — Reação muito expressiva (grito, susto, choro) com contexto de jogo claro",
    " 6 — Resultado relevante + reação moderada, ou tensão alta antes de resultado",
    " 5 — Reação forte mas sem contexto visual claro; ou boa jogada sem reação",
    " 3 — Apenas pico de áudio sem contexto de jogo identificável",
    " 1 — Fala neutra, risada sem motivo, ação sem relevância",
  ].join("\n");

  // Monta o array de content com texto + imagem por candidato
  const contentParts: any[] = [{ type: "text", text: systemText }];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const transcriptSummary = c.transcript?.fullText?.trim()
      ? `"${c.transcript.fullText.slice(0, 300)}${c.transcript.fullText.length > 300 ? "…" : ""}"`
      : "(sem transcrição disponível)";

    contentParts.push({
      type: "text",
      text:
        `\n\n── Candidato ${i} ──\n` +
        `Tempo: ${c.candidate.centerSec.toFixed(1)}s | ` +
        `Pico: ${c.candidate.peakDb.toFixed(1)} dB\n` +
        `Fala: ${transcriptSummary}`,
    });

    if (c.frameBase64) {
      contentParts.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: c.frameBase64 },
      });
    }
  }

  contentParts.push({
    type: "text",
    text:
      `\n\nResponda SOMENTE JSON puro (sem markdown, sem explicação), ` +
      `lista com até ${maxClips} itens ordenados do melhor ao pior:\n` +
      `[{"index":0,"reason":"<motivo curto em pt-BR>","score":8.5}]`,
  });

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: contentParts }],
      }),
    });
  } catch (err: any) {
    console.warn(`[selectHighlights] fetch para Claude falhou: ${err.message}`);
    return [];
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[selectHighlights] Claude retornou ${res.status}: ${body.slice(0, 200)}`);
    return [];
  }

  const json = await res.json();
  const text: string = json.content?.find((b: any) => b.type === "text")?.text ?? "[]";
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    console.warn("[selectHighlights] JSON inválido da Claude, usando fallback heurístico.");
    return [];
  }
}

// ── Seleção principal ─────────────────────────────────────────────────────────

/**
 * Seleciona os melhores trechos do vídeo para virar clipes.
 *
 * Recebe CandidateWithContext[] — cada candidato já traz transcrição do seu
 * trecho de áudio e um frame representativo para análise visual.
 *
 * O ranking usa Claude com visão computacional + prompt especializado em cassino.
 * Fallback automático para ranking por pico de áudio quando Claude não está disponível.
 */
export async function selectHighlights(
  candidates: CandidateWithContext[],
  opts: SelectOptions = {}
): Promise<Highlight[]> {
  const maxClips    = opts.maxClips    ?? 8;
  const maxDuration = opts.maxClipDurationSec ?? 45;
  const preferredGame = opts.preferredGame ?? "all";

  const padBefore = opts.padBeforeSec ?? Math.min(Math.floor(maxDuration * 0.40), 30);
  const padAfter  = opts.padAfterSec  ?? Math.min(Math.floor(maxDuration * 0.60), 40);

  console.log(
    `[selectHighlights] candidatos=${candidates.length}  maxDuration=${maxDuration}s` +
    `  padBefore=${padBefore}s  padAfter=${padAfter}s  maxClips=${maxClips}  jogo=${preferredGame}`
  );

  if (candidates.length === 0) return [];

  const ranked = await askClaudeToRank(candidates, maxClips, preferredGame);

  type Chosen = {
    idx: number;
    reason: string;
    score: number;
    source: "ia" | "audio";
  };

  let chosen: Chosen[];

  if (ranked.length > 0) {
    console.log(`[selectHighlights] Claude ranqueou ${ranked.length} momentos:`);
    ranked.forEach((r) =>
      console.log(`  [${r.index}] score=${r.score}  reason="${r.reason}"`)
    );

    chosen = ranked
      .filter(({ index }) => Boolean(candidates[index]))
      .map(({ index, reason, score }) => ({
        idx: index, reason, score, source: "ia" as const,
      } satisfies Chosen));
  } else {
    console.log("[selectHighlights] Fallback: ranking por pico de áudio.");
    chosen = candidates
      .map((c, i) => ({
        idx: i,
        reason: "Pico de reação de áudio",
        score: parseFloat((10 - i * 0.5).toFixed(1)),
        source: "audio" as const,
      }))
      .slice(0, maxClips);
  }

  return chosen.map(({ idx, reason, score, source }) => {
    const c = candidates[idx];
    const rawStart = c.candidate.centerSec - padBefore;
    const rawEnd   = c.candidate.centerSec + padAfter;
    const startSec = Math.max(0, rawStart);
    const endSec   = Math.min(rawEnd, startSec + maxDuration);
    const duration = endSec - startSec;

    console.log(
      `[selectHighlights] clipe: ${startSec.toFixed(1)}s–${endSec.toFixed(1)}s ` +
      `(${duration.toFixed(1)}s)  score=${score}  fonte=${source}  reason="${reason}"`
    );

    return {
      startSec,
      endSec,
      reason,
      score,
      source,
      // Transcript já 0-indexed relativo ao início do candidato ≈ início do clipe
      transcript: c.transcript ?? undefined,
    };
  });
}
