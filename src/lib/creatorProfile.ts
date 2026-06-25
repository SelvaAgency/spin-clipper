import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";

export interface CreatorProfile {
  id: string;
  name: string;
  /** Jogo principal do streamer */
  preferredGame: "baccarat" | "blackjack" | "roulette" | "all";
  /** Duração padrão dos clipes em segundos */
  clipDurationSec: number;
  /** Multiplicador da sensibilidade de áudio (0.5 = menos sensível, 2.0 = mais sensível) */
  audioSensitivity: number;
  /** Notas livres sobre o estilo do streamer */
  notes: string;
  createdAt: string;
  updatedAt: string;
}

const STORE_PATH = path.resolve("data/profiles.json");

function readAll(): Record<string, CreatorProfile> {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeAll(profiles: Record<string, CreatorProfile>) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(profiles, null, 2));
}

export function createProfile(
  data: Omit<CreatorProfile, "id" | "createdAt" | "updatedAt">
): CreatorProfile {
  const profiles = readAll();
  const profile: CreatorProfile = {
    ...data,
    id: uuid(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  profiles[profile.id] = profile;
  writeAll(profiles);
  return profile;
}

export function getProfile(id: string): CreatorProfile | undefined {
  return readAll()[id];
}

export function listProfiles(): CreatorProfile[] {
  return Object.values(readAll());
}

export function updateProfile(
  id: string,
  patch: Partial<Omit<CreatorProfile, "id" | "createdAt">>
): CreatorProfile | null {
  const profiles = readAll();
  if (!profiles[id]) return null;
  profiles[id] = { ...profiles[id], ...patch, updatedAt: new Date().toISOString() };
  writeAll(profiles);
  return profiles[id];
}

export function deleteProfile(id: string): boolean {
  const profiles = readAll();
  if (!profiles[id]) return false;
  delete profiles[id];
  writeAll(profiles);
  return true;
}
