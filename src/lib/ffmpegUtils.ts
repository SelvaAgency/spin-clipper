import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Executa um comando e rejeita se o exit code não for 0.
 * timeoutMs (default 20 min) mata o processo se ele não terminar — evita que
 * um filter_complex com fonte infinita trave o pipeline para sempre.
 */
export function run(cmd: string, args: string[], timeoutMs = 20 * 60 * 1000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
      const preview = args.slice(0, 12).join(" ");
      reject(new Error(`${cmd} timeout após ${timeoutMs / 1000}s. Comando: ${cmd} ${preview}`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return; // já rejeitou
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} saiu com código ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

/** Roda ffmpeg, mas devolve o buffer bruto de stdout (usado pra extrair PCM de áudio). */
export function runCapture(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d) => chunks.push(d as Buffer));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${cmd} saiu com código ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

export interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fps: number;
}

export async function probe(filePath: string): Promise<ProbeInfo> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const vStream = data.streams.find((s: any) => s.codec_type === "video");
  const aStream = data.streams.find((s: any) => s.codec_type === "audio");
  const fpsRaw: string = vStream?.r_frame_rate ?? "30/1";
  const [num, den] = fpsRaw.split("/").map(Number);
  return {
    durationSec: parseFloat(data.format.duration ?? vStream?.duration ?? "0"),
    width: vStream?.width ?? 0,
    height: vStream?.height ?? 0,
    hasAudio: !!aStream,
    fps: den ? num / den : num,
  };
}
