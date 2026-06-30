import fs from "node:fs";
import path from "node:path";
import { run } from "./ffmpegUtils.js";
import type { TranscriptWord } from "./transcribe.js";
import type { MolduraConfig } from "./molduras.js";

// ── Profanity ──────────────────────────────────────────────────────────────────

const PROFANITY_CONFIG = path.resolve("assets/config/profanity-ptbr.json");

/** Lista embutida usada como fallback se o arquivo de config não existir */
const PROFANITY_FALLBACK: string[] = [
  "caralho", "porra", "merda", "cacete",
  "foda", "foda-se", "fodase", "foder", "fodendo",
  "puta", "putaria", "puta merda",
  "filho da puta", "filha da puta",
  "vai se foder", "vai tomar no cu", "tomar no cu",
  "cu", "cuzão", "cuzao", "buceta", "boceta",
  "arrombado", "arrombada",
  "vsf", "vtf", "vtnc", "fdp",
  "viado", "babaca", "desgraça", "desgraca",
];

function loadProfanityList(): string[] {
  try {
    if (fs.existsSync(PROFANITY_CONFIG)) {
      const json = JSON.parse(fs.readFileSync(PROFANITY_CONFIG, "utf-8"));
      if (Array.isArray(json.words)) {
        return (json.words as unknown[]).filter((w): w is string => typeof w === "string");
      }
    }
  } catch { /* fall through */ }
  return PROFANITY_FALLBACK;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacritics
    .replace(/[-_]/g, "")            // remove hyphens/underscores (foda-se → fodase)
    .replace(/[^a-z0-9 ]/g, "")     // keep only alphanumeric + space
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CensoredWord {
  /** Texto original detectado (pode ser frase de múltiplas palavras) */
  original: string;
  startSec: number;
  endSec: number;
}

/**
 * Detecta palavrões em uma lista de palavras transcritas.
 * Suporta palavras únicas e frases de múltiplas palavras.
 * Frases têm prioridade — se "filho da puta" for detectado, "puta" isolado não é.
 */
export function detectProfanity(words: TranscriptWord[]): CensoredWord[] {
  const profList = loadProfanityList();
  const singles  = profList.filter((p) => !p.includes(" "));
  const phrases  = profList
    .filter((p) => p.includes(" "))
    .map((p) => normalizeForMatch(p).split(" ").filter(Boolean));

  const singleSet = new Set(singles.map((p) => normalizeForMatch(p)));
  const result: CensoredWord[] = [];
  const covered = new Set<number>(); // índices já cobertos por uma frase

  // 1. Detectar frases multi-palavra (maior prioridade)
  for (const phraseNorm of phrases) {
    const n = phraseNorm.length;
    for (let i = 0; i <= words.length - n; i++) {
      const window = words.slice(i, i + n);
      const match  = window.every((w, j) => {
        const norm = normalizeForMatch(w.text);
        // Tolerância: a palavra normalizada começa com o token da frase
        // (lida com variações de sufixo como "caralhos", "fodendo")
        return norm === phraseNorm[j] || norm.startsWith(phraseNorm[j]);
      });
      if (match) {
        result.push({
          original: window.map((w) => w.text).join(" "),
          startSec: window[0].startSec,
          endSec:   window[n - 1].endSec,
        });
        for (let j = i; j < i + n; j++) covered.add(j);
      }
    }
  }

  // 2. Detectar palavras únicas não cobertas por frases
  words.forEach((w, i) => {
    if (covered.has(i)) return;
    const norm = normalizeForMatch(w.text);
    // Verificação exata + variações de sufixo simples (plurais, flexões)
    const matched = [...singleSet].some(
      (p) => norm === p || (p.length >= 4 && norm.startsWith(p) && norm.length <= p.length + 3)
    );
    if (matched) {
      result.push({ original: w.text, startSec: w.startSec, endSec: w.endSec });
    }
  });

  return result;
}

// ── Caption positioning ────────────────────────────────────────────────────────

function getCaptionLayout(moldura: MolduraConfig): { cx: number; cy: number; maxWidth: number } {
  if (moldura.windows.length >= 2) {
    const [top, bot] = moldura.windows;
    return {
      cx:       Math.round(moldura.canvasWidth / 2),
      cy:       Math.round((top.y + top.height + bot.y) / 2),
      maxWidth: Math.round(moldura.canvasWidth * 0.87),
    };
  }
  const [win] = moldura.windows;
  return {
    cx:       Math.round(moldura.canvasWidth / 2),
    cy:       Math.round((win.y + win.height + moldura.canvasHeight) / 2),
    maxWidth: Math.round(moldura.canvasWidth * 0.87),
  };
}

// ── Typography ─────────────────────────────────────────────────────────────────

const CHAR_WIDTH_RATIO = 0.62;
const FONT_SIZES = [52, 46, 40, 36, 32] as const;

function fontSizeForLine(charCount: number, maxWidth: number): number {
  for (const sz of FONT_SIZES) {
    if (charCount * sz * CHAR_WIDTH_RATIO <= maxWidth) return sz;
  }
  return FONT_SIZES[FONT_SIZES.length - 1];
}

// ── Grouping ───────────────────────────────────────────────────────────────────

/**
 * Agrupa palavras em blocos de uma única linha.
 * Divide temporalmente quando adicionar outra palavra estouraria a largura.
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
    const addLen = w.text.length + (current.length > 0 ? 1 : 0);
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

// ── ASS builder ────────────────────────────────────────────────────────────────

function formatAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function censorPhrase(text: string): string {
  return text
    .split(" ")
    .map((w) => (w.length <= 1 ? w : w[0] + "*".repeat(w.length - 1)))
    .join(" ");
}

function censorLine(text: string, censoredWords: CensoredWord[]): string {
  // Ordenar por tamanho desc para substituir frases antes de palavras individuais
  const sorted = [...censoredWords].sort((a, b) => b.original.length - a.original.length);
  let result = text;
  for (const cw of sorted) {
    const pattern = new RegExp(
      cw.original.split(" ").map(escapeRegex).join("\\s+"),
      "gi"
    );
    result = result.replace(pattern, censorPhrase(cw.original));
  }
  return result;
}

/**
 * Gera arquivo ASS posicionado no gap entre cam e mesa (moldura split),
 * ou na zona inferior (moldura full).
 *
 * Estilo: Strenuous Black, branco, sem contorno, sem sombra, caixa alta.
 * Uma única linha por bloco — fonte reduzida automaticamente se necessário.
 * Palavrões censurados com primeira letra + asteriscos.
 */
export function buildAssFile(
  groups: Array<{ text: string; startSec: number; endSec: number }>,
  moldura: MolduraConfig,
  outputPath: string,
  censoredWords: CensoredWord[] = []
) {
  const { cx, cy, maxWidth } = getCaptionLayout(moldura);

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
      const start = formatAssTime(Math.max(0, g.startSec));
      const end   = formatAssTime(Math.max(0, g.endSec));
      const text  = censorLine(g.text, censoredWords).toUpperCase();
      const size  = fontSizeForLine(text.length, maxWidth);
      const tags  = `{\\an5\\pos(${cx},${cy})\\fs${size}\\bord0\\shad0}`;
      return `Dialogue: 0,${start},${end},Default,${tags}${text}`;
    })
    .join("\n");

  fs.writeFileSync(outputPath, header + lines + "\n");
}

// ── Caption burning ────────────────────────────────────────────────────────────

const FONTS_DIR = path.resolve("assets/fonts");

/**
 * Queima legendas ASS no vídeo.
 * Com censoredWords + beepPath: muta os intervalos dos palavrões e sobrepõe beep.
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

  const enableExpr = words
    .map((w) => `between(t,${w.startSec.toFixed(3)},${w.endSec.toFixed(3)})`)
    .join("+");

  const filterParts: string[] = [];
  filterParts.push(`[0:v]ass=filename='${fixedAssPath}':fontsdir='${fixedFontsDir}'[vout]`);
  filterParts.push(`[0:a]volume=enable='${enableExpr}':volume=0[muted]`);

  if (words.length === 1) {
    const w   = words[0];
    const dur = Math.max(0.05, w.endSec - w.startSec).toFixed(3);
    const ms  = Math.round(w.startSec * 1000);
    filterParts.push(`[1:a]atrim=0:${dur},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[b0]`);
  } else {
    const splitOuts = words.map((_, i) => `[bs${i}]`).join("");
    filterParts.push(`[1:a]asplit=${words.length}${splitOuts}`);
    words.forEach((w, i) => {
      const dur = Math.max(0.05, w.endSec - w.startSec).toFixed(3);
      const ms  = Math.round(w.startSec * 1000);
      filterParts.push(`[bs${i}]atrim=0:${dur},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[b${i}]`);
    });
  }

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
