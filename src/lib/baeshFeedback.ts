import fs from "node:fs";
import path from "node:path";

export type BaeshRating =
  | "excellent" | "good"
  | "bad" | "repetitive" | "cut-early" | "cut-late"
  | "bad-motion" | "product-hidden";

export interface BaeshFeedbackEntry {
  id: string;
  jobId: string;
  segmentId: string;
  rating: BaeshRating;
  createdAt: string;
}

const STORE = path.resolve("data/baesh_feedback.json");

function readAll(): BaeshFeedbackEntry[] {
  if (!fs.existsSync(STORE)) return [];
  return JSON.parse(fs.readFileSync(STORE, "utf-8"));
}

function writeAll(entries: BaeshFeedbackEntry[]) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(entries, null, 2));
}

export function saveBaeshFeedback(entry: Omit<BaeshFeedbackEntry, "id" | "createdAt">): BaeshFeedbackEntry {
  const all = readAll();
  const record: BaeshFeedbackEntry = {
    ...entry,
    id: `bf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };
  all.push(record);
  writeAll(all);
  return record;
}

export function getAllBaeshFeedback(): BaeshFeedbackEntry[] {
  return readAll();
}
