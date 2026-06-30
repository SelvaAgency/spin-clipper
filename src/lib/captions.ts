import fs from "node:fs";
import path from "node:path";
import { run } from "./ffmpegUtils.js";
import type { TranscriptWord } from "./transcribe.js";
import type { MolduraConfig } from "./molduras.js";

// ── Profanity ──────────────────────────────────────────────────────────────────

// Palavrões PT-BR — adicione ou remova palavras conforme necessário
const PROFANITY_LIST: string[] = [
  "caralho", "porra", "merda", "foda", "fode", "fodase",
  "puta", "putamerda", "viado", "vsf", "vtf", "vtnc", "vsfp",
  "cu", "cuzao", "cuzão", "bundao", "bundão",
  "buceta", "boceta",
  "fdp", "fdputa", "filhadaputa", "filhodaputa",
  "desgraca", "desgraça", "arrombado", "arrombada",
  "babaca", "idiota", "imbecil", "cretino", "cretina",
];

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // remove diacritics
    .replace(/[^a-z0-9]/g, "");        // keep only alphanumeric
}

export interface CensoredWord {
  original: string;
  startSec: number;
  endSec: number;
}

export function detectProfanity(words: TranscriptWord[]): CensoredWord[] {
  const profSet = new Set(PROFANITY_LIST.map(normalizeForMatch));
  return words
    .filter((w) => profSet.has(normalizeForMatch(w.text)))
    .map((w) => ({ original: w.text, startSec: w.startSec, endSec: w.endSec }));
}

// ── Caption positioning ────────────────────────────────────────────────────────

function getCaptionLayout(moldura: MolduraConfig): { cx: number; cy: number; maxWidth: number } {
  if (moldura.windows.length >= 2) {
    // Split: center of gap between top (cam) and bottom (mesa) windows
    const [top, bot] = moldura.windows;
    return {
      cx:       Math.round(moldura.canvasWidth / 2),
      cy:       Math.round((top.y + top.height + bot.y) / 2),
      maxWidth: Math.round(moldura.canvasWidth * 0.87),
    };
  }
  // Full: below the single window, in the bottom safe zone
  const [win] = moldura.windows;
  return {
    cx:       Math.round(moldura.canvasWidth / 2),
    cy:       Math.round((win.y + win.height + moldura.canvasHeight) / 2),
    maxWidth: Math.round(moldura.canvasWidth * 0.87),
  };
}

// ── Typography ─────────────────────────────────────────────────────────────────

// Estimated width of one uppercase char in Strenuous Black, relative to font size
const CHAR_WIDTH_RATIO = 0.62;

// Font size steps — try each until text fits on one line
const FONT_SIZES = [52, 46, 40, 36, 32] as const;

function fontSizeForLine(charCount: number, maxWidth: number): number {
  for (const sz of FONT_SIZES) {
    if (charCount * sz * CHAR_WIDTH_RATIO <= maxWidth) return sz;
  }
  return FONT_SIZES[FONT_SIZES.length - 1];
}

// ── Grouping ───────────────────────────────────────────────────────────────────

/**
 * Groups words into single-line caption blocks.
 * Each block fits on one line at the default font size.
 * When adding a word would overflow the line, a new block is started (temporal split).
 */
export function groupWordsSingleLine(
  words: TranscriptWord[],
  maxWidth = 900,
  defaultFontSize: number = FONT_SIZES[0]
): TranscriptWord[][] {
  const maxChars = Math.floor(maxWidth / (defaultFontSize * CHAR_WIDTH_RATIO));
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];
  let currentChars = 0;

  for (const w of words) {
    const addLen = w.text.length + (current.length > 0 ? 1 : 0); // +1 for space
    const endsSentence = /[.!?]$/.test(w.text);

    if (current.length > 0 && currentChars + addLen > maxChars) {
      groups.push(current);
      current = [w];
      currentChars = w.text.length;
    } else {
      current.push(w);
      currentChars += addLen;
    }

    if (endsSentence) {
      if (current.length > 0) groups.push(current);
      current = [];
      currentChars = 0;
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

// ── ASS file builder ───────────────────────────────────────────────────────────

function formatAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/**
 * Builds an ASS subtitle file positioned in the gap between cam and mesa windows.
 *
 * Style: Strenuous Black, white, no outline, no shadow, uppercase, single line.
 * Font size is auto-reduced per line to prevent overflow (never wraps).
 * Profanity in censoredWords is replaced with "C***" form in the captions.
 */
export function buildAssFile(
  groups: Array<{ text: string; startSec: number; endSec: number }>,
  moldura: MolduraConfig,
  outputPath: string,
  censoredWords: CensoredWord[] = []
) {
  const { cx, cy, maxWidth } = getCaptionLayout(moldura);

  // Build censorship lookup: normalized original → "C***" form
  const censorMap = new Map<string, string>(
    censoredWords.map((cw) => [
      normalizeForMatch(cw.original),
      cw.original[0].toUpperCase() + "*".repeat(Math.max(0, cw.original.length - 1)),
    ])
  );

  function censorLine(text: string): string {
    return text.split(" ").map((w) => {
      const key = normalizeForMatch(w);
      return censorMap.has(key) ? censorMap.get(key)! : w;
    }).join(" ");
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${moldura.canvasWidth}
PlayResY: ${moldura.canvasHeight}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Strenuous Black,52,&H00FFFFFF&,&H000000FF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Text
`;

  const lines = groups
    .filter((g) => g.text.trim().length > 0)
    .map((g) => {
      const start  = formatAssTime(Math.max(0, g.startSec));
      const end    = formatAssTime(Math.max(0, g.endSec));
      const text   = censorLine(g.text).toUpperCase();
      const size   = fontSizeForLine(text.length, maxWidth);
      // \an5 = middle-center alignment, \pos absolute, \fs font size, \bord0 no border, \shad0 no shadow
      const tags   = `{\\an5\\pos(${cx},${cy})\\fs${size}\\bord0\\shad0}`;
      return `Dialogue: 0,${start},${end},Default,${tags}${text}`;
    })
    .join("\n");

  fs.writeFileSync(outputPath, header + lines + "\n");
}

// ── Caption burning ────────────────────────────────────────────────────────────

const FONTS_DIR = path.resolve("assets/fonts");

/**
 * Burns ASS captions into the video.
 * When censoredWords + beepPath are provided, also mutes the profanity windows
 * in the audio track and overlays a beep sound at each word's exact timestamp.
 */
export async function burnCaptions(
  inputVideo: string,
  assPath: string,
  outputVideo: string,
  opts: { censoredWords?: CensoredWord[]; beepPath?: string } = {}
) {
  const fixedAssPath  = path.resolve(assPath).replace(/\\/g, "/").replace(/:/g, "\\:");
  const fixedFontsDir = FONTS_DIR.replace(/\\/g, "/").replace(/:/g, "\\:");

  const words    = opts.censoredWords ?? [];
  const beepPath = opts.beepPath;
  const hasCensor = words.length > 0 && !!beepPath && fs.existsSync(beepPath);

  if (!hasCensor) {
    await run("ffmpeg", [
      "-y", "-i", inputVideo,
      "-vf", `ass='${fixedAssPath}':fontsdir='${fixedFontsDir}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "copy",
      outputVideo,
    ]);
    return;
  }

  // Mute profanity in audio + overlay beep at each word's timestamp
  const enableExpr = words
    .map((w) => `between(t,${w.startSec.toFixed(3)},${w.endSec.toFixed(3)})`)
    .join("+");

  const filterParts: string[] = [];

  // Video: burn ASS captions
  filterParts.push(
    `[0:v]ass=filename='${fixedAssPath}':fontsdir='${fixedFontsDir}'[vout]`
  );

  // Audio: mute the censored windows
  filterParts.push(`[0:a]volume=enable='${enableExpr}':volume=0[muted]`);

  // Beep audio: split + delay for each censored word
  if (words.length === 1) {
    const w   = words[0];
    const dur = Math.max(0.05, w.endSec - w.startSec).toFixed(3);
    const ms  = Math.round(w.startSec * 1000);
    filterParts.push(
      `[1:a]atrim=0:${dur},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[b0]`
    );
  } else {
    const splitOuts = words.map((_, i) => `[bs${i}]`).join("");
    filterParts.push(`[1:a]asplit=${words.length}${splitOuts}`);
    words.forEach((w, i) => {
      const dur = Math.max(0.05, w.endSec - w.startSec).toFixed(3);
      const ms  = Math.round(w.startSec * 1000);
      filterParts.push(
        `[bs${i}]atrim=0:${dur},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[b${i}]`
      );
    });
  }

  // Mix: muted original + all beeps
  const mixIn = `[muted]` + words.map((_, i) => `[b${i}]`).join("");
  filterParts.push(`${mixIn}amix=inputs=${words.length + 1}:normalize=0[aout]`);

  await run("ffmpeg", [
    "-y",
    "-i", inputVideo,
    "-i", beepPath!,
    "-filter_complex", filterParts.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k",
    outputVideo,
  ]);
}
