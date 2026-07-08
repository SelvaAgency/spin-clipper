import fs from "node:fs";
import path from "node:path";

export type JobStatus =
  | "queued"
  | "running"
  | "waiting-crop-approval"
  | "waiting-layout-approval"
  | "waiting-composition-preview"
  | "waiting-captions-approval"
  | "done"
  | "error"
  | "cancelled";

export interface CropApprovalData {
  previewUrl: string;
  detected: { x: number; y: number; w: number; h: number };
  videoW: number;
  videoH: number;
  /** "game" quando se trata do crop da mesa/jogo; omitido para o streamer */
  target?: "game";
}

export interface LayoutApprovalData {
  previewUrl: string;
  webcam: { x: number; y: number; w: number; h: number };
  game: { x: number; y: number; w: number; h: number };
  videoW: number;
  videoH: number;
}

export interface CaptionGroup {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface ClipCaptionData {
  clipId: string;
  clipUrl: string;
  startSec: number;
  endSec: number;
  groups: CaptionGroup[];
}

export interface CaptionsApprovalData {
  clips: ClipCaptionData[];
}

export interface CompositionPreviewData {
  previewUrl: string;
  /** true se o vídeo do streamer existe e teve crop pedido */
  hasStreamer: boolean;
  /** true se o vídeo da mesa existe e teve crop pedido */
  hasMesa: boolean;
}

export type ApprovalData = CropApprovalData | LayoutApprovalData | CaptionsApprovalData | CompositionPreviewData;

export interface ApprovalRequest {
  type: "crop" | "layout" | "captions" | "composition-preview";
  data: ApprovalData;
}

export interface ApprovalResponse {
  type: "crop" | "layout" | "captions" | "composition-preview";
  approved: boolean;
  /** For crop: { x, y, w, h }. For layout: { webcam, game }. For captions: { clips: [...] }. For composition-preview: { action: "adjust-streamer" | "adjust-mesa" } */
  adjustedData?: any;
}

export interface Job {
  id: string;
  status: JobStatus;
  log: string[];
  createdAt: string;
  clips: Array<{
    url: string;
    reason: string;
    score?: number;
    startSec: number;
    endSec: number;
    source?: "ia" | "audio";
    moldura?: string;
    mode?: string;
  }>;
  compilationUrl?: string;
  pendingApproval?: ApprovalRequest;
  /** profileId do streamer associado a este job */
  profileId?: string;
  error?: string;
  /** which client created this job */
  clientId?: string;
  /** client-specific result payload */
  clientResult?: unknown;
}

const STORE_PATH = path.resolve("data/jobs.json");

function readAll(): Record<string, Job> {
  if (!fs.existsSync(STORE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
}

function writeAll(jobs: Record<string, Job>) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(jobs, null, 2));
}

export function createJob(id: string): Job {
  const jobs = readAll();
  const job: Job = { id, status: "queued", log: [], createdAt: new Date().toISOString(), clips: [] };
  jobs[id] = job;
  writeAll(jobs);
  return job;
}

export function getJob(id: string): Job | undefined {
  return readAll()[id];
}

export function updateJob(id: string, patch: Partial<Job>) {
  const jobs = readAll();
  if (!jobs[id]) return;
  jobs[id] = { ...jobs[id], ...patch };
  writeAll(jobs);
}

export function appendLog(id: string, message: string) {
  const jobs = readAll();
  if (!jobs[id]) return;
  jobs[id].log.push(message);
  writeAll(jobs);
}
