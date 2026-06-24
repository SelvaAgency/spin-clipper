import fs from "node:fs";
import path from "node:path";
import { run } from "../src/lib/ffmpegUtils.js";
import { composeMoldura } from "../src/lib/compose.js";

const TMP = path.resolve("data/tmp");
const OUT = path.resolve("data/output");

async function makeSynthetic(label: string, outPath: string, colorSeed: string) {
  // testsrc com texto identificando a fonte, + tom de áudio, 8s, vertical-ish pra forçar o crop "cover"
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=960x540:rate=30:duration=8`,
    "-f", "lavfi", "-i", `sine=frequency=${colorSeed}:duration=8`,
    "-vf", `drawtext=text='${label}':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    outPath,
  ]);
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const streamerClip = path.join(TMP, "synthetic_streamer.mp4");
  const mesaClip = path.join(TMP, "synthetic_mesa.mp4");

  console.log("Gerando clipes sintéticos de teste...");
  await makeSynthetic("STREAMER CAM", streamerClip, "440");
  await makeSynthetic("MESA / ROLETA", mesaClip, "220");

  console.log("Testando moldura SPLIT (MOLDURA_SPIN.png)...");
  await composeMoldura({
    moldura: "split",
    streamerClip,
    mesaClip,
    outputPath: path.join(OUT, "teste_split.mp4"),
    primaryAudio: "mix",
  });

  console.log("Testando moldura FULL com streamer (MOLDURA_SPIN2.png)...");
  await composeMoldura({
    moldura: "full",
    streamerClip,
    fullSource: "streamer",
    outputPath: path.join(OUT, "teste_full_streamer.mp4"),
  });

  console.log("Testando moldura FULL com mesa (MOLDURA_SPIN2.png)...");
  await composeMoldura({
    moldura: "full",
    mesaClip,
    fullSource: "mesa",
    outputPath: path.join(OUT, "teste_full_mesa.mp4"),
  });

  console.log("\nPronto. Arquivos em data/output/:");
  console.log("  - teste_split.mp4         (streamer em cima, mesa embaixo, áudio dos dois)");
  console.log("  - teste_full_streamer.mp4 (streamer ocupando a janela única)");
  console.log("  - teste_full_mesa.mp4     (mesa ocupando a janela única)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
