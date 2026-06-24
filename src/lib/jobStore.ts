import fs from "node:fs";
import path from "node:path";

export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
  id: string;
  status: JobStatus;
  log: string[];
  createdAt: string;
  clips: Array<{ url: string; reason: string; startSec: number; endSec: number }>;
  error?: string;
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
