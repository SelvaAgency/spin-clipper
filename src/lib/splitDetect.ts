import { probe } from "./ffmpegUtils.js";

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitRegions {
  webcam: Region;
  game: Region;
}

/**
 * Heuristic detection of webcam + game regions from a single combined video.
 * Assumes the webcam is a corner overlay (~28% of width) at the bottom-right.
 * The game fills the full frame.
 */
export async function detectSplitRegions(videoPath: string): Promise<SplitRegions> {
  const info = await probe(videoPath);
  const { width: W, height: H } = info;

  const camW = Math.round(W * 0.28);
  const camH = Math.round(H * 0.28);

  return {
    webcam: { x: W - camW, y: H - camH, w: camW, h: camH },
    game: { x: 0, y: 0, w: W, h: H },
  };
}
