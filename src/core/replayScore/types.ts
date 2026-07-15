export interface AudioSignal {
  centerSec: number;
  peakDb: number;
}

export interface HighlightSignal {
  startSec: number;
  endSec: number;
  score?: number;
  reason: string;
  source: "ia" | "audio";
}

export interface ReplayMarker {
  timeSec: number;
  type: "audio-peak" | "ai-highlight" | "top-moment" | "casino";
  emoji: string;
  label: string;
  color: string;
  intensity: number;
}

export interface ReplayFrame {
  timeSec: number;
  score: number;
  markers: ReplayMarker[];
}

export interface ReplayHighlight {
  startSec: number;
  endSec: number;
  centerSec: number;
  peakScore: number;
  reason: string;
  source: "ia" | "audio";
}

export interface ReplayScore {
  jobId: string;
  videoDurationSec: number;
  frames: ReplayFrame[];
  highlights: ReplayHighlight[];
  computedAt: string;
}

export interface ComputeReplayScoreInput {
  jobId: string;
  videoDurationSec: number;
  audioCandidates: AudioSignal[];
  highlights: HighlightSignal[];
}
