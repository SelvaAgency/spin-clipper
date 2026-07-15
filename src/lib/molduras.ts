// Coordenadas extraídas automaticamente do canal alpha dos PNGs reais
// (assets/molduras/MOLDURA_CASINO.png e MOLDURA_CASINO2.png).
// Se a moldura mudar de design, rode `npm run inspect-molduras` para regerar isto.

export interface VideoWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MolduraConfig {
  id: string;
  file: string;
  canvasWidth: number;
  canvasHeight: number;
  /** 1 janela = uma fonte de vídeo preenche tudo. 2 janelas = split streamer/mesa. */
  windows: VideoWindow[];
}

export const MOLDURAS: Record<string, MolduraConfig> = {
  split: {
    id: "split",
    file: "MOLDURA_CASINO.png",
    canvasWidth: 1080,
    canvasHeight: 1920,
    windows: [
      // janela de cima: câmera do streamer
      { x: 34, y: 51, width: 1017, height: 540 },
      // janela de baixo: mesa / roleta
      { x: 34, y: 685, width: 1018, height: 1083 },
    ],
  },
  full: {
    id: "full",
    file: "MOLDURA_CASINO2.png",
    canvasWidth: 1080,
    canvasHeight: 1920,
    windows: [
      // janela única: streamer OU mesa, tela cheia
      { x: 34, y: 50, width: 1018, height: 1717 },
    ],
  },
};

export function getMoldura(id: string): MolduraConfig {
  const m = MOLDURAS[id];
  if (!m) throw new Error(`Moldura desconhecida: ${id}. Opções: ${Object.keys(MOLDURAS).join(", ")}`);
  return m;
}
