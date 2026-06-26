import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";

export type FeedbackRating = "great" | "good" | "bad";

export interface ClipFeedback {
  id: string;
  jobId: string;
  clipIndex: number;
  clipUrl: string;
  rating?: FeedbackRating;
  /** Chips/tags selecionados pelo usuário */
  tags?: string[];
  /** Comentário livre do usuário */
  comment?: string;
  edits?: {
    crop?: { x: number; y: number; w: number; h: number };
    startSec?: number;
    endSec?: number;
    notes?: string;
  };
  /** Metadados do momento — base para treinamento futuro */
  metadata: {
    startSec: number;
    endSec: number;
    durationSec: number;
    reason: string;
    score?: number;
    source: "ia" | "audio";
    moldura: string;
    mode: string;
  };
  createdAt: string;
  updatedAt: string;
}

const STORE_PATH = path.resolve("data/feedback.json");

function readAll(): ClipFeedback[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")); }
  catch { return []; }
}

function writeAll(list: ClipFeedback[]) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2));
}

export function saveFeedback(
  data: Omit<ClipFeedback, "id" | "createdAt" | "updatedAt">
): ClipFeedback {
  const list = readAll();
  const idx  = list.findIndex(f => f.jobId === data.jobId && f.clipIndex === data.clipIndex);
  const now  = new Date().toISOString();

  if (idx >= 0) {
    list[idx] = { ...list[idx], ...data, updatedAt: now };
    writeAll(list);
    return list[idx];
  }

  const entry: ClipFeedback = { ...data, id: uuid(), createdAt: now, updatedAt: now };
  list.push(entry);
  writeAll(list);
  return entry;
}

export function getAllFeedback(): ClipFeedback[] {
  return readAll();
}

export function getFeedbackByJob(jobId: string): ClipFeedback[] {
  return readAll().filter(f => f.jobId === jobId);
}

export function getFeedbackStats() {
  const list = readAll();

  // Frequência de cada tag para identificar padrões
  const tagCount: Record<string, number> = {};
  for (const f of list) {
    for (const tag of (f.tags ?? [])) {
      tagCount[tag] = (tagCount[tag] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(tagCount)
    .sort(([, a], [, b]) => b - a)
    .map(([tag, count]) => ({ tag, count }));

  return {
    total:        list.length,
    great:        list.filter(f => f.rating === "great").length,
    good:         list.filter(f => f.rating === "good").length,
    bad:          list.filter(f => f.rating === "bad").length,
    withComments: list.filter(f => f.comment?.trim()).length,
    withTags:     list.filter(f => f.tags && f.tags.length > 0).length,
    topTags,
  };
}
