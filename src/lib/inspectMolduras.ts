import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { VideoWindow } from "./molduras.js";

const ASSETS_DIR = path.resolve("assets/molduras");
const ALPHA_THRESHOLD = 10; // pixels com alpha abaixo disso contam como "janela transparente"

function loadAlpha(filePath: string): { width: number; height: number; alpha: Uint8Array } {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  const alpha = new Uint8Array(png.width * png.height);
  for (let i = 0; i < png.width * png.height; i++) {
    alpha[i] = png.data[i * 4 + 3];
  }
  return { width: png.width, height: png.height, alpha };
}

/** Encontra retângulos transparentes (as "janelas" de vídeo) varrendo por bandas de linha. */
function findWindows(width: number, height: number, alpha: Uint8Array): VideoWindow[] {
  const rowHasTransparent: boolean[] = new Array(height).fill(false);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] < ALPHA_THRESHOLD) {
        rowHasTransparent[y] = true;
        break;
      }
    }
  }

  const bands: Array<[number, number]> = [];
  let bandStart = -1;
  for (let y = 0; y < height; y++) {
    if (rowHasTransparent[y] && bandStart === -1) bandStart = y;
    if (!rowHasTransparent[y] && bandStart !== -1) {
      bands.push([bandStart, y - 1]);
      bandStart = -1;
    }
  }
  if (bandStart !== -1) bands.push([bandStart, height - 1]);

  return bands.map(([y0, y1]) => {
    let xMin = width;
    let xMax = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = 0; x < width; x++) {
        if (alpha[y * width + x] < ALPHA_THRESHOLD) {
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
        }
      }
    }
    return { x: xMin, y: y0, width: xMax - xMin + 1, height: y1 - y0 + 1 };
  });
}

function main() {
  for (const file of ["MOLDURA_CASINO.png", "MOLDURA_CASINO2.png"]) {
    const filePath = path.join(ASSETS_DIR, file);
    const { width, height, alpha } = loadAlpha(filePath);
    const windows = findWindows(width, height, alpha);
    console.log(`\n${file} (${width}x${height})`);
    windows.forEach((w, i) => console.log(`  janela ${i}: x=${w.x} y=${w.y} w=${w.width} h=${w.height}`));
  }
  console.log(
    "\nSe esses números baterem com src/lib/molduras.ts, está tudo certo. Se a moldura mudou, copie os valores pra lá."
  );
}

main();
