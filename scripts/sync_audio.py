#!/usr/bin/env python3
"""
Acha o deslocamento temporal entre dois arquivos de vídeo/áudio comparando
o envelope de energia do áudio (cross-correlation). Útil quando o streamer
grava a própria câmera e a mesa/roleta é gravada separadamente (sem timecode
comum), então precisamos descobrir "a mesa começa X segundos depois (ou antes)
do streamer".

Uso:
    python3 sync_audio.py arquivo_a.mp4 arquivo_b.mp4

Saída (stdout, JSON):
    {"offset_sec": 12.34, "confidence": 0.81}

offset_sec positivo significa: arquivo_b começa offset_sec DEPOIS do arquivo_a
(ou seja, pra alinhar, corte os primeiros offset_sec do arquivo_a, ou some
offset_sec ao timestamp do arquivo_a quando for buscar o trecho correspondente
no arquivo_b).

Limitação conhecida: isso assume que existe correlação de áudio entre as duas
fontes (ex: o microfone do streamer capta um pouco do som ambiente da mesa, ou
as duas gravações têm a mesma trilha de fundo). Se as fontes forem
completamente isoladas (streamer em silêncio total, mesa sem áudio ambiente
captável), a correlação não funciona e cai pra confidence baixa — nesse caso
o alinhamento manual (ou um clap/marcador sonoro no início da gravação) é
necessário.
"""
import json
import subprocess
import sys
import numpy as np
from scipy.signal import correlate, resample


SR = 8000  # taxa de amostragem reduzida só pra achar o offset (não precisa de qualidade)
MAX_ANALYSIS_SEC = 600  # não vale a pena correlacionar mais que 10min de cada


def extract_envelope(path: str, sr: int = SR, max_sec: int = MAX_ANALYSIS_SEC) -> np.ndarray:
    cmd = [
        "ffmpeg", "-v", "error",
        "-i", path,
        "-t", str(max_sec),
        "-ac", "1",
        "-ar", str(sr),
        "-f", "f32le",
        "-",
    ]
    raw = subprocess.run(cmd, stdout=subprocess.PIPE, check=True).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    if audio.size == 0:
        return audio
    # envelope = energia em janelas de ~50ms, suaviza ruído e reduz custo da correlação
    window = max(int(sr * 0.05), 1)
    n_windows = audio.size // window
    audio = audio[: n_windows * window]
    energy = (audio.reshape(n_windows, window) ** 2).mean(axis=1)
    return energy


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"error": "uso: sync_audio.py arquivo_a arquivo_b"}))
        sys.exit(1)

    path_a, path_b = sys.argv[1], sys.argv[2]
    env_a = extract_envelope(path_a)
    env_b = extract_envelope(path_b)

    if env_a.size < 10 or env_b.size < 10:
        print(json.dumps({"error": "áudio insuficiente pra correlacionar", "offset_sec": 0, "confidence": 0.0}))
        return

    env_a = (env_a - env_a.mean()) / (env_a.std() + 1e-9)
    env_b = (env_b - env_b.mean()) / (env_b.std() + 1e-9)

    corr = correlate(env_b, env_a, mode="full")
    lag_windows = np.argmax(corr) - (len(env_a) - 1)
    window_sec = 0.05
    offset_sec = lag_windows * window_sec

    peak = corr.max()
    norm = np.sqrt((env_a ** 2).sum() * (env_b ** 2).sum()) + 1e-9
    confidence = float(peak / norm)

    print(json.dumps({"offset_sec": float(offset_sec), "confidence": confidence}))


if __name__ == "__main__":
    main()
