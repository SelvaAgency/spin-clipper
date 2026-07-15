import type {
  ComputeReplayScoreInput,
  ReplayScore,
  ReplayFrame,
  ReplayMarker,
  ReplayHighlight,
} from "./types.js";

const CASINO_KEYWORDS = /natural|blackjack|bust|21|tie|par|banker|player|streak|baccarat|roulette|roleta|ganho|win|lucro/i;
const AUDIO_SIGMA = 2.5;
const HL_TAPER    = 1.5;

function gaussian(dt: number, sigma: number): number {
  return Math.exp(-(dt * dt) / (2 * sigma * sigma));
}

function percentileNorm(arr: number[], p5: number, p95: number): number[] {
  if (p95 <= p5) return arr.map(() => 0);
  const range = p95 - p5;
  return arr.map(v => Math.max(0, Math.min(100, ((v - p5) / range) * 100)));
}

function computePercentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

export function computeReplayScore(input: ComputeReplayScoreInput): ReplayScore {
  const n = Math.max(1, Math.ceil(input.videoDurationSec));
  const audioLayer = new Float64Array(n);
  const hlLayer    = new Float64Array(n);

  // ── Audio layer: Gaussian bell around each peak ─────────────────────────────
  for (const cand of input.audioCandidates) {
    const idx = Math.round(cand.centerSec);
    // Normalize peakDb: -40 dB → 0, -5 dB → 100 (clamp 0-100)
    const intensity = Math.max(0, Math.min(100, (cand.peakDb + 40) * (100 / 35)));
    for (let t = 0; t < n; t++) {
      const w = gaussian(t - idx, AUDIO_SIGMA);
      if (w > 0.01) audioLayer[t] += intensity * w;
    }
  }

  // ── Highlight layer: plateau with tapered edges ──────────────────────────────
  for (const hl of input.highlights) {
    const score = hl.score ?? 50;
    const s = hl.startSec, e = hl.endSec;
    for (let t = 0; t < n; t++) {
      let w = 0;
      const dt_start = t - s, dt_end = e - t;
      if (dt_start >= 0 && dt_end >= 0) {
        // Inside the segment: full plateau, tapered at edges
        const edgeDist = Math.min(dt_start, dt_end);
        w = edgeDist < HL_TAPER ? edgeDist / HL_TAPER : 1.0;
      } else {
        // Outside: fast Gaussian decay
        const dt = dt_start < 0 ? dt_start : -dt_end;
        w = gaussian(dt, 1.0) * 0.3;
      }
      if (w > 0.01) hlLayer[t] += score * w;
    }
  }

  // ── Blend: 40% audio + 60% highlights ───────────────────────────────────────
  const raw = Array.from({ length: n }, (_, t) => audioLayer[t] * 0.40 + hlLayer[t] * 0.60);
  const p5  = computePercentile(raw, 5);
  const p95 = computePercentile(raw, 95);
  const scores = percentileNorm(raw, p5, p95);

  // ── Markers ──────────────────────────────────────────────────────────────────
  const topThreshold = computePercentile(scores, 85);
  const frameMap = new Map<number, ReplayMarker[]>();

  const addMarker = (timeSec: number, m: ReplayMarker) => {
    const t = Math.round(timeSec);
    if (t >= 0 && t < n) {
      if (!frameMap.has(t)) frameMap.set(t, []);
      frameMap.get(t)!.push(m);
    }
  };

  // Audio peak markers
  for (const cand of input.audioCandidates) {
    const intensity = Math.max(0, Math.min(100, (cand.peakDb + 40) * (100 / 35)));
    if (intensity > 55) {
      addMarker(cand.centerSec, {
        timeSec: cand.centerSec, type: "audio-peak",
        emoji: "🎤", label: `Pico de áudio (${cand.peakDb.toFixed(0)} dB)`,
        color: "#3498db", intensity,
      });
    }
  }

  // Highlight markers
  for (const hl of input.highlights) {
    const center = (hl.startSec + hl.endSec) / 2;
    const isCasino = CASINO_KEYWORDS.test(hl.reason);
    addMarker(center, {
      timeSec: center, type: hl.source === "ia" ? "ai-highlight" : "audio-peak",
      emoji: isCasino ? "🎰" : hl.source === "ia" ? "⭐" : "🔥",
      label: hl.reason.slice(0, 60),
      color: isCasino ? "#9b59b6" : hl.source === "ia" ? "#f1c40f" : "#e67e22",
      intensity: hl.score ?? 50,
    });
  }

  // Top moment markers
  for (let t = 0; t < n; t++) {
    if (scores[t] >= topThreshold && scores[t] > 70) {
      const existing = frameMap.get(t);
      if (!existing?.some(m => m.type === "top-moment")) {
        addMarker(t, {
          timeSec: t, type: "top-moment",
          emoji: "🔥", label: `Top momento (score ${scores[t].toFixed(0)})`,
          color: "#e67e22", intensity: scores[t],
        });
      }
    }
  }

  // ── Build frames ─────────────────────────────────────────────────────────────
  const frames: ReplayFrame[] = Array.from({ length: n }, (_, t) => ({
    timeSec: t,
    score: Math.round(scores[t]),
    markers: frameMap.get(t) ?? [],
  }));

  // ── Mapped highlights ─────────────────────────────────────────────────────────
  const highlights: ReplayHighlight[] = input.highlights.map(hl => {
    const s = Math.max(0, Math.floor(hl.startSec));
    const e = Math.min(n - 1, Math.ceil(hl.endSec));
    let peakScore = 0;
    for (let t = s; t <= e; t++) peakScore = Math.max(peakScore, scores[t]);
    return {
      startSec:  hl.startSec,
      endSec:    hl.endSec,
      centerSec: (hl.startSec + hl.endSec) / 2,
      peakScore: Math.round(peakScore),
      reason:    hl.reason,
      source:    hl.source,
    };
  });

  return {
    jobId:            input.jobId,
    videoDurationSec: input.videoDurationSec,
    frames,
    highlights,
    computedAt: new Date().toISOString(),
  };
}
