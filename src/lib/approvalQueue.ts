import type { ApprovalResponse } from "./jobStore.js";

const queue = new Map<string, (response: ApprovalResponse) => void>();

export function waitForApproval(jobId: string): Promise<ApprovalResponse> {
  return new Promise((resolve) => {
    queue.set(jobId, resolve);
  });
}

export function submitApproval(jobId: string, response: ApprovalResponse): boolean {
  const resolver = queue.get(jobId);
  if (!resolver) return false;
  queue.delete(jobId);
  resolver(response);
  return true;
}

export function hasPendingApproval(jobId: string): boolean {
  return queue.has(jobId);
}
