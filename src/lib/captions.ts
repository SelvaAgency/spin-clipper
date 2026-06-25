import fs from "node:fs";
import path from "node:path";
import { run } from "./ffmpegUtils.js";
import type { TranscriptWord } from "./transcribe.js";

export interface CaptionStyle {
  fontName?: string;
  fontSize?: number;
  primaryColor?: string;
  outlineColor?: string;
  marginVertical?: number;
}

const DEFAULT_STYLE: Required<CaptionStyle> = {
  fontName: "Montserrat",
  fontSize: 64,
  primaryColor: "&H00FFFFFF&",
  outlineColor: "&H00662D87&",
  marginVertical: 140,
};

function formatAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s
    .toFixed(2)
    .padStart(5, "0")}`;
}

function groupWords(
  words: TranscriptWord[],
  maxWordsPerGroup = 4
): TranscriptWord[][] {
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  for (const w of words) {
    current.push(w);

    const endsSentence = /[.!?]$/.test(w.text);

    if (current.length >= maxWordsPerGroup || endsSentence) {
      groups.push(current);
      current = [];
    }
  }

  if (current.length) {
    groups.push(current);
  }

  return groups;
}

export function buildAssFile(
  words: TranscriptWord[],
  clipStartSec: number,
  outputPath: string,
  style: CaptionStyle = {}
) {
  const s = { ...DEFAULT_STYLE, ...style };

  const relativeWords = words.map((w) => ({
    text: w.text,
    startSec: w.startSec - clipStartSec,
    endSec: w.endSec - clipStartSec,
  }));

  const groups = groupWords(relativeWords);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginV
Style: Default,${s.fontName},${s.fontSize},${s.primaryColor},${s.outlineColor},1,1,4,0,2,${s.marginVertical}

[Events]
Format: Layer, Start, End, Style, Text
`;

  const lines = groups
    .filter((g) => g.length > 0)
    .map((g) => {
      const start = formatAssTime(Math.max(0, g[0].startSec));
      const end = formatAssTime(Math.max(0, g[g.length - 1].endSec));
      const text = g
        .map((w) => w.text)
        .join(" ")
        .toUpperCase();

      return `Dialogue: 0,${start},${end},Default,${text}`;
    })
    .join("\n");

  fs.writeFileSync(outputPath, header + lines + "\n");
}

export async function burnCaptions(
  inputVideo: string,
  assPath: string,
  outputVideo: string
) {
  const fixedAssPath = path
    .resolve(assPath)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");

  await run("ffmpeg", [
    "-y",
    "-i",
    inputVideo,
    "-vf",
    `ass='${fixedAssPath}'`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "copy",
    outputVideo,
  ]);
}