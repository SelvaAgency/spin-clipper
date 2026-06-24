import fs from "node:fs";
import { run } from "./ffmpegUtils.js";
import type { TranscriptWord } from "./transcribe.js";

export interface CaptionStyle {
  fontName?: string;
  fontSize?: number;
  primaryColor?: string; // formato ASS: &HBBGGRR&
  outlineColor?: string;
  marginVertical?: number;
}

const DEFAULT_STYLE: Required<CaptionStyle> = {
  fontName: "Montserrat",
  fontSize: 64,
  primaryColor: "&H00FFFFFF&", // branco
  outlineColor: "&H00662D87&", // roxo SPIN (BGR), pra casar com a moldura
  marginVertical: 140,
};

function formatAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${m.toString().padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Agrupa palavras em blocos curtos (até ~4 palavras ou troca de frase) pra legenda estilo Reels */
function groupWords(words: TranscriptWord[], maxWordsPerGroup = 4): TranscriptWord[][] {
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
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Gera um .ass com timestamps relativos ao INÍCIO DO CLIPE (não do vídeo bruto).
 * Quem chama essa função já deve ter recortado `words` pra janela do clipe e
 * subtraído `clipStartSec` de cada timestamp.
 */
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
      const text = g.map((w) => w.text).join(" ").toUpperCase();
      return `Dialogue: 0,${start},${end},Default,${text}`;
    })
    .join("\n");

  fs.writeFileSync(outputPath, header + lines + "\n");
}

/** Queima o .ass no vídeo já composto (depois da moldura, antes do outro) */
export async function burnCaptions(inputVideo: string, assPath: string, outputVideo: string) {
  await run("ffmpeg", [
    "-y",
    "-i", inputVideo,
    "-vf", `ass=${assPath}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "copy",
    outputVideo,
  ]);
}
