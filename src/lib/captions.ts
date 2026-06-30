import fs from "node:fs";
import path from "node:path";
import { run, probe } from "./ffmpegUtils.js";
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

export interface BeepFile {
  path: string;
  durationSec: number;
}

/**
 * Seleciona o beep mais adequado para cobrir a duração do palavrão.
 *
 * Critério: menor excesso (beep ligeiramente maior que o palavrão é ideal).
 * Déficit é penalizado 2× para ser última opção.
 * Entre candidatos igualmente bons, evita os últimos 3 usados para variar.
 */
function selectBeepForDuration(
  beepFiles: BeepFile[],
  targetDuration: number,
  recentlyUsed: string[]
): BeepFile {
  if (beepFiles.length === 1) return beepFiles[0];

  const scored = beepFiles
    .map((b) => {
      const diff = b.durationSec - targetDuration;
      return { b, score: diff >= 0 ? diff : -diff * 2 };
    })
    .sort((a, b) => a.score - b.score);

  const top = scored.slice(0, Math.min(4, scored.length)).map((s) => s.b);
  const recent = new Set(recentlyUsed.slice(-3));
  const fresh = top.filter((b) => !recent.has(b.path));
  return fresh.length > 0 ? fresh[0] : top[0];
}

/**
 * Queima legendas ASS no vídeo.
 *
 * Fluxo quando censura está habilitada:
 *   Pass 1 — queima legendas, copia áudio → arquivo temporário
 *   Pass 2 — seleciona beep por duração de cada palavrão e aplica via concat
 *
 * Se nenhum arquivo de beep estiver disponível ou válido: avisa e entrega
 * o vídeo SEM censura de áudio (não interrompe a geração).
 */
export async function burnCaptions(
  inputVideo: string,
  assPath: string,
  outputVideo: string,
  opts: { censoredWords?: CensoredWord[]; beepPaths?: string[] } = {}
) {
  const fixedAssPath  = path.resolve(assPath).replace(/\\/g, "/").replace(/:/g, "\\:");
  const fixedFontsDir = FONTS_DIR.replace(/\\/g, "/").replace(/:/g, "\\:");

  const words     = (opts.censoredWords ?? []).filter((w) => w.endSec > w.startSec);
  const rawPaths  = (opts.beepPaths ?? []).map((p) => path.resolve(p));

  // ── Validar e sondar todos os arquivos de beep ──────────────────────────
  let beepFiles: BeepFile[] = [];

  if (words.length > 0) {
    console.log(`[censor] ${words.length} palavrão(ões) detectado(s):`);
    for (const w of words) {
      console.log(
        `[censor]   "${w.original}"  ${w.startSec.toFixed(3)}s → ${w.endSec.toFixed(3)}s  (${(w.endSec - w.startSec).toFixed(3)}s)`
      );
    }

    if (rawPaths.length === 0) {
      console.warn(`[censor] AVISO: nenhum beep configurado — censura de áudio ignorada`);
    } else {
      for (const p of rawPaths) {
        if (!fs.existsSync(p)) {
          console.warn(`[censor]   beep não encontrado: ${p}`);
          continue;
        }
        if (fs.statSync(p).size < 100) {
          console.warn(`[censor]   beep muito pequeno: ${path.basename(p)}`);
          continue;
        }
        try {
          const info = await probe(p);
          if (!info.hasAudio || info.durationSec <= 0) {
            console.warn(`[censor]   beep sem áudio válido: ${path.basename(p)}`);
          } else {
            beepFiles.push({ path: p, durationSec: info.durationSec });
          }
        } catch (err: any) {
          console.warn(`[censor]   probe falhou (${path.basename(p)}): ${err.message.split("\n")[0]}`);
        }
      }
      beepFiles.sort((a, b) => a.durationSec - b.durationSec);
      if (beepFiles.length > 0) {
        console.log(
          `[censor] ${beepFiles.length} beep(s) válido(s): ` +
          beepFiles.map((b) => `${path.basename(b.path)}(${b.durationSec.toFixed(2)}s)`).join(", ")
        );
      } else {
        console.warn(`[censor] AVISO: nenhum beep válido — censura de áudio ignorada`);
      }
    }
  }

  // ── Pass 1 — queimar legendas ────────────────────────────────────────────
  const hasCensorship = words.length > 0 && beepFiles.length > 0;

  if (!hasCensorship) {
    console.log(`[censor] Queimando legendas sem censura de áudio`);
    await run("ffmpeg", [
      "-y", "-i", inputVideo,
      "-vf", `ass='${fixedAssPath}':fontsdir='${fixedFontsDir}'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "copy",
      outputVideo,
    ]);
    return;
  }

  const tempCap = outputVideo.replace(/\.mp4$/i, "_tmpcap.mp4");

  console.log(`[censor] Pass 1: queimando legendas → ${path.basename(tempCap)}`);
  await run("ffmpeg", [
    "-y", "-i", inputVideo,
    "-vf", `ass='${fixedAssPath}':fontsdir='${fixedFontsDir}'`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "copy",
    tempCap,
  ]);

  // ── Pass 2 — censura de áudio via concat com beep selecionado por duração ─
  try {
    await applyCensorshipConcat(tempCap, beepFiles, words, outputVideo);
  } catch (err: any) {
    console.warn(`[censor] AVISO: censura de áudio falhou — entregando vídeo sem beep`);
    console.warn(`[censor]   ${err.message}`);
    fs.copyFileSync(tempCap, outputVideo);
  } finally {
    try { fs.unlinkSync(tempCap); } catch { /* noop */ }
  }
}

/**
 * Aplica censura de áudio via concatenação de segmentos.
 *
 * Para cada palavrão detectado:
 *   1. Seleciona o beep com duração mais próxima (preferindo cobertura total)
 *   2. Evita repetir os últimos 3 beeps usados para garantir variedade
 *   3. Cada beep é uma entrada FFmpeg separada — sem reutilizar o mesmo arquivo
 *
 * Vídeo é copiado sem reencoding (já foi reencoded no pass 1).
 */
async function applyCensorshipConcat(
  inputVideo: string,
  beepFiles: BeepFile[],
  words: CensoredWord[],
  outputVideo: string
): Promise<void> {
  // Ordenar e mesclar intervalos sobrepostos
  const sorted = [...words].sort((a, b) => a.startSec - b.startSec);
  const merged: CensoredWord[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.startSec < last.endSec) {
      merged[merged.length - 1] = { ...last, endSec: Math.max(last.endSec, curr.endSec) };
    } else {
      merged.push(curr);
    }
  }

  // Selecionar beep para cada palavrão (com variedade)
  const usedPaths: string[] = [];
  const assignedBeeps: Array<{ beepFile: BeepFile; duration: number }> = [];

  for (const w of merged) {
    const profDur  = w.endSec - w.startSec;
    const selected = selectBeepForDuration(beepFiles, profDur, usedPaths);
    const duration = Math.min(Math.max(0.05, profDur), selected.durationSec);
    assignedBeeps.push({ beepFile: selected, duration });
    usedPaths.push(selected.path);
    console.log(
      `[censor]   ${w.startSec.toFixed(3)}s→${w.endSec.toFixed(3)}s` +
      ` (${profDur.toFixed(3)}s) → ${path.basename(selected.path)}` +
      ` (${selected.durationSec.toFixed(2)}s disponível, usando ${duration.toFixed(3)}s)`
    );
  }

  // Montar lista de segmentos na ordem temporal
  interface CleanSeg { kind: "clean"; start: number; end?: number }
  interface BeepSeg  { kind: "beep";  idx: number;  duration: number }
  type Seg = CleanSeg | BeepSeg;

  const segs: Seg[] = [];
  let cursor  = 0;
  let beepIdx = 0;

  for (const w of merged) {
    if (w.startSec - cursor > 0.001) {
      segs.push({ kind: "clean", start: cursor, end: w.startSec });
    }
    segs.push({ kind: "beep", idx: beepIdx, duration: assignedBeeps[beepIdx].duration });
    beepIdx++;
    cursor = w.endSec;
  }
  segs.push({ kind: "clean", start: cursor });

  const cleanSegs = segs.filter((s): s is CleanSeg => s.kind === "clean");

  // Normalização de áudio: concat exige sample rate, sample format e canais idênticos.
  // Cada beep é uma entrada FFmpeg separada ([1:a], [2:a], ...) evitando asplit no beep.
  const CH = "aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp";

  const fp: string[] = [];

  // Segmentos limpos — todos vêm de [0:a] via asplit
  if (cleanSegs.length === 1) {
    const s = cleanSegs[0];
    const trim = s.end !== undefined
      ? `start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)}`
      : `start=${s.start.toFixed(3)}`;
    fp.push(`[0:a]atrim=${trim},asetpts=PTS-STARTPTS,${CH}[clean0]`);
  } else {
    fp.push(`[0:a]asplit=${cleanSegs.length}${cleanSegs.map((_, i) => `[csrc${i}]`).join("")}`);
    cleanSegs.forEach((s, i) => {
      const trim = s.end !== undefined
        ? `start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)}`
        : `start=${s.start.toFixed(3)}`;
      fp.push(`[csrc${i}]atrim=${trim},asetpts=PTS-STARTPTS,${CH}[clean${i}]`);
    });
  }

  // Segmentos de beep — cada um vem de sua própria entrada ([1:a], [2:a], ...)
  assignedBeeps.forEach((ab, i) => {
    fp.push(
      `[${i + 1}:a]atrim=start=0:end=${ab.duration.toFixed(3)},asetpts=PTS-STARTPTS,${CH}[beep${i}]`
    );
  });

  // Concat final na ordem temporal
  let ci = 0;
  let bi = 0;
  const labels = segs
    .map((s) => (s.kind === "clean" ? `[clean${ci++}]` : `[beep${bi++}]`))
    .join("");
  fp.push(`${labels}concat=n=${segs.length}:v=0:a=1[aout]`);

  const filterStr = fp.join(";");
  console.log(`[censor] Pass 2: ${assignedBeeps.length} beep(s) | filter=${filterStr}`);

  // Cada beep é um -i separado (inputs 1..N)
  const beepInputArgs = assignedBeeps.flatMap((ab) => ["-i", ab.beepFile.path]);

  await run("ffmpeg", [
    "-y",
    "-i", inputVideo,
    ...beepInputArgs,
    "-filter_complex", filterStr,
    "-map", "0:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    outputVideo,
  ]);
}
