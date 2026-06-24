import fs from "node:fs";

const API_BASE = "https://api.assemblyai.com/v2";

export interface TranscriptWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface Transcript {
  words: TranscriptWord[];
  /** texto corrido, útil pra mandar pra IA de seleção sem ficar remontando a partir das palavras */
  fullText: string;
}

function requireApiKey(): string {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) {
    throw new Error(
      "ASSEMBLYAI_API_KEY não configurada. Pega uma chave em assemblyai.com e põe no .env."
    );
  }
  return key;
}

async function uploadFile(filePath: string, apiKey: string): Promise<string> {
  const data = fs.readFileSync(filePath);
  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: { authorization: apiKey },
    body: data,
  });
  if (!res.ok) throw new Error(`Upload AssemblyAI falhou: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.upload_url;
}

async function requestTranscript(uploadUrl: string, apiKey: string): Promise<string> {
  const res = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadUrl,
      language_code: "pt", // português (AssemblyAI detecta BR automaticamente dentro do modelo pt)
      punctuate: true,
      format_text: true,
    }),
  });
  if (!res.ok) throw new Error(`Criação de transcript falhou: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function pollTranscript(id: string, apiKey: string): Promise<any> {
  while (true) {
    const res = await fetch(`${API_BASE}/transcript/${id}`, {
      headers: { authorization: apiKey },
    });
    const json = await res.json();
    if (json.status === "completed") return json;
    if (json.status === "error") throw new Error(`Transcrição falhou: ${json.error}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Transcreve o áudio (geralmente a trilha do streamer, que é onde rolam as reações/falas) */
export async function transcribe(filePath: string): Promise<Transcript> {
  const apiKey = requireApiKey();
  const uploadUrl = await uploadFile(filePath, apiKey);
  const id = await requestTranscript(uploadUrl, apiKey);
  const result = await pollTranscript(id, apiKey);

  const words: TranscriptWord[] = (result.words ?? []).map((w: any) => ({
    text: w.text,
    startSec: w.start / 1000,
    endSec: w.end / 1000,
  }));

  return { words, fullText: result.text ?? "" };
}

/** Recorta as palavras do transcript dentro de uma janela de tempo, pra montar legenda de um clipe específico */
export function sliceTranscript(transcript: Transcript, startSec: number, endSec: number): TranscriptWord[] {
  return transcript.words.filter((w) => w.startSec >= startSec && w.endSec <= endSec);
}
