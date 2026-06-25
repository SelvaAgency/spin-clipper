import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";

export type FeedbackRating = "great" | "good" | "bad";

export interface ClipFeedback {
  id: string;
  jobId: string;
  /** Índice do clipe dentro do job (0-based) */
  clipIndex: number;
  clipUrl: string;
  rating?: FeedbackRating;
  /** Dados editados pelo usuário via UI */
  edits?: {
    crop?: { x: number; y: number; w: number; h: number };
    startSec?: number;
    endSec?: number;
    notes?: string;
  };
  /** Metadados do momento detectado — essenciais para treinamento futuro */
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
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeAll(list: ClipFeedback[]) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2));
}

/** Cria ou atualiza o feedback de um clipe específico. */
export function saveFeedback(
  data: Omit<ClipFeedback, "id" | "createdAt" | "updatedAt">
): ClipFeedback {
  const list = readAll();
  const existing = list.findIndex(
    (f) => f.jobId === data.jobId && f.clipIndex === data.clipIndex
  );
  const now = new Date().toISOString();

  if (existing >= 0) {
    list[existing] = { ...list[existing], ...data, updatedAt: now };
    writeAll(list);
    return list[existing];
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
  return readAll().filter((f) => f.jobId === jobId);
}

/**
 * Estatísticas agregadas — úteis para mostrar ao usuário e para calibrar o modelo.
 */
export function getFeedbackStats(): {
  total: number;
  great: number;
  good: number;
  bad: number;
  withEdits: number;
} {
  const list = readAll();
  return {
    total: list.length,
    great: list.filter((f) => f.rating === "great").length,
    good: list.filter((f) => f.rating === "good").length,
    bad: list.filter((f) => f.rating === "bad").length,
    withEdits: list.filter((f) => f.edits && Object.keys(f.edits).length > 0).length,
  };
}
