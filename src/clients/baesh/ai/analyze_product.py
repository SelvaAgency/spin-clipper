#!/usr/bin/env python3
"""
analyze_product.py — Editor automático de vídeos de produto.

Analisa um vídeo longo frame a frame, pontua cada trecho e seleciona
automaticamente os melhores momentos para compor um vídeo curto e dinâmico.

Saída: JSON para stdout.

Uso:
  python3 analyze_product.py <video>
    [--fps N]              amostragem (default 4)
    [--target-sec S]       duração desejada do vídeo final (default 45)
    [--min-seg-sec S]      duração mínima de um trecho (default 1.5)
    [--max-seg-sec S]      duração máxima de um trecho (default 8)
    [--scale-w W]          largura de análise (default 320)
    [--scale-h H]          altura de análise (default 180)
"""
import sys, json, subprocess, argparse
import numpy as np


# ── Utilidades ───────────────────────────────────────────────────────────────

def smooth(values, window):
    half = window // 2
    out = []
    for i in range(len(values)):
        lo = max(0, i - half)
        hi = min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def normalize_to_100(values, p_low=5, p_high=95):
    """Normaliza lista para 0-100 usando clipping por percentil."""
    arr = np.array(values, dtype=float)
    lo = float(np.percentile(arr, p_low))
    hi = float(np.percentile(arr, p_high))
    if hi <= lo:
        return [50.0] * len(values)
    return [float(min(100.0, max(0.0, (v - lo) / (hi - lo) * 100.0))) for v in values]


def fmt_time(sec):
    sec = int(sec)
    return f"{sec//60:02d}:{sec%60:02d}"


# ── Análise por frame ────────────────────────────────────────────────────────

def analyze_frame(img_rgb, gray, prev_gray):
    """
    img_rgb: ndarray (H, W, 3) float32
    gray:    ndarray (H, W)    float32
    Retorna dict com métricas brutas.
    """
    h, w = gray.shape
    ch, cw = h // 3, w // 3

    # ── Foco: variância do Laplaciano no terço central ────────────────────
    center = gray[ch:2*ch, cw:2*cw]
    d2x = center[:, :-2] - 2.0 * center[:, 1:-1] + center[:, 2:]
    d2y = center[:-2, :] - 2.0 * center[1:-1, :] + center[2:, :]
    sz = (min(d2x.shape[0], d2y.shape[0]), min(d2x.shape[1], d2y.shape[1]))
    focus = float(np.var(d2x[:sz[0], :sz[1]] + d2y[:sz[0], :sz[1]]))

    # ── Movimento: diferença média vs frame anterior ───────────────────────
    motion = float(np.mean(np.abs(gray - prev_gray))) if prev_gray is not None else 0.0

    # ── Iluminação ────────────────────────────────────────────────────────
    brightness = float(np.mean(gray))
    # Ideal ~140. Penaliza escuro e saturado (superexposto)
    light_score = max(0.0, 100.0 - abs(brightness - 140.0) * 0.65)

    # ── Composição: conteúdo no centro vs bordas ─────────────────────────
    center_mean = float(np.mean(gray[ch:2*ch, cw:2*cw]))
    border_mean = (
        float(np.mean(gray[:ch, :])) +
        float(np.mean(gray[2*ch:, :])) +
        float(np.mean(gray[:, :cw])) +
        float(np.mean(gray[:, 2*cw:]))
    ) / 4.0
    full_mean = float(np.mean(gray))
    composition_raw = center_mean / (full_mean + 1.0)

    # ── Interesse visual: densidade de arestas no centro ─────────────────
    sx = np.abs(center[:, 1:] - center[:, :-1])
    sy = np.abs(center[1:, :] - center[:-1, :])
    interest = float(np.mean(sx) + np.mean(sy))

    # ── Saturação ─────────────────────────────────────────────────────────
    r, g, b = img_rgb[:, :, 0], img_rgb[:, :, 1], img_rgb[:, :, 2]
    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    saturation = float(np.mean((max_c - min_c) / (max_c + 1.0)))

    return {
        'focus':       focus,
        'motion':      motion,
        'light_score': light_score,
        'composition': composition_raw,
        'interest':    interest,
        'saturation':  saturation,
        'brightness':  brightness,
    }


# ── Pontuação e descrição de segmentos ──────────────────────────────────────

def score_segment(seg_frames):
    """Recebe lista de dicts de métricas normalizadas. Devolve score 0-100 + motivos."""
    keys = ('focus_n', 'stability_n', 'light_score', 'composition_n', 'interest_n',
            'motion_n', 'saturation')
    avg = {}
    for k in keys:
        vals = [f.get(k, 0.0) for f in seg_frames]
        avg[k] = sum(vals) / max(1, len(vals))

    # Ponderação principal
    score = (
        avg['focus_n']       * 0.35 +
        avg['stability_n']   * 0.25 +
        avg['light_score']   * 0.20 +
        avg['composition_n'] * 0.10 +
        avg['interest_n']    * 0.10
    )

    # Penalidades graves
    if avg['focus_n'] < 25:
        score = max(0.0, score - 35.0)   # desfocado
    if avg['stability_n'] < 20:
        score = max(0.0, score - 30.0)   # tremendo
    if avg['motion_n'] > 78:
        score = max(0.0, score - 20.0)   # câmera buscando enquadramento
    if avg['light_score'] < 30:
        score = max(0.0, score - 15.0)   # muito escuro / superexposto

    score = min(99.0, max(1.0, score))

    # Motivos positivos
    motives = []
    if avg['focus_n'] > 85:
        motives.append("Foco nítido")
    elif avg['focus_n'] > 70:
        motives.append("Produto em foco")
    if avg['stability_n'] > 85:
        motives.append("Câmera estável")
    elif avg['stability_n'] > 70:
        motives.append("Tomada suave")
    if avg['light_score'] > 80:
        motives.append("Boa iluminação")
    if avg['composition_n'] > 70:
        motives.append("Produto centralizado")
    if avg['interest_n'] > 70:
        motives.append("Detalhes visíveis")
    if avg['saturation'] > 0.25:
        motives.append("Cores vivas")
    if avg['focus_n'] > 80 and avg['stability_n'] > 80:
        motives.append("Tomada limpa")
    if not motives:
        motives.append("Tomada válida")

    # Penalidades descritivas
    penalties = []
    if avg['focus_n'] < 30:
        penalties.append("Desfocado")
    if avg['stability_n'] < 30:
        penalties.append("Câmera tremendo")
    if avg['motion_n'] > 70:
        penalties.append("Movimento brusco")
    if avg['light_score'] < 35:
        penalties.append("Iluminação ruim")

    return round(score, 1), motives, penalties, {
        'focus':       round(avg['focus_n'],       1),
        'stability':   round(avg['stability_n'],   1),
        'lighting':    round(avg['light_score'],   1),
        'composition': round(avg['composition_n'], 1),
        'interest':    round(avg['interest_n'],    1),
    }


# ── Pontos naturais de corte ─────────────────────────────────────────────────

def find_cut_points(motions, times, fps, min_seg_sec):
    smoothed = smooth(motions, 5)
    motion_mean = sum(smoothed) / max(1, len(smoothed))
    threshold = motion_mean * 0.55
    min_gap = max(3, int(min_seg_sec * fps))

    cut_times = [0.0]
    last_cut = 0

    for i in range(2, len(smoothed) - 2):
        is_valley = (
            smoothed[i] <= smoothed[i-1] and
            smoothed[i] <= smoothed[i+1] and
            smoothed[i] < threshold and
            i - last_cut >= min_gap
        )
        if is_valley:
            cut_times.append(times[i])
            last_cut = i

    return cut_times


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--fps',         type=float, default=4.0)
    ap.add_argument('--target-sec',  type=float, default=45.0)
    ap.add_argument('--min-seg-sec', type=float, default=1.5)
    ap.add_argument('--max-seg-sec', type=float, default=8.0)
    ap.add_argument('--scale-w',     type=int,   default=320)
    ap.add_argument('--scale-h',     type=int,   default=180)
    args = ap.parse_args()

    W, H = args.scale_w, args.scale_h
    frame_size = W * H * 3  # RGB24

    # ── Extrair frames via FFmpeg ─────────────────────────────────────────
    proc = subprocess.Popen([
        'ffmpeg', '-i', args.video,
        '-vf', f'fps={args.fps},scale={W}:{H}',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-loglevel', 'error', 'pipe:1',
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    raw_frames = []
    frame_times = []
    idx = 0
    while True:
        data = proc.stdout.read(frame_size)
        if len(data) < frame_size:
            break
        raw_frames.append(data)
        frame_times.append(idx / args.fps)
        idx += 1
    proc.wait()

    if len(raw_frames) < 8:
        print(json.dumps({'segments': [], 'selected_segments': [],
                          'duration_sec': 0, 'total_selected_sec': 0,
                          'target_sec': args.target_sec}))
        return

    # ── Analisar frames ───────────────────────────────────────────────────
    analyzed = []
    prev_gray = None
    for rb in raw_frames:
        img = np.frombuffer(rb, dtype=np.uint8).reshape(H, W, 3).astype(np.float32)
        gray = 0.299 * img[:, :, 0] + 0.587 * img[:, :, 1] + 0.114 * img[:, :, 2]
        fm = analyze_frame(img, gray, prev_gray)
        analyzed.append(fm)
        prev_gray = gray

    # ── Normalizar métricas para 0-100 ───────────────────────────────────
    for key, out_key in [('focus', 'focus_n'), ('interest', 'interest_n'),
                         ('composition', 'composition_n'), ('motion', 'motion_n')]:
        normed = normalize_to_100([f[key] for f in analyzed])
        for i, f in enumerate(analyzed):
            f[out_key] = normed[i]

    for f in analyzed:
        f['stability_n'] = max(0.0, 100.0 - f['motion_n'])

    # ── Pontos de corte naturais ──────────────────────────────────────────
    motions = [f['motion'] for f in analyzed]
    cut_times = find_cut_points(motions, frame_times, args.fps, args.min_seg_sec)

    video_end = frame_times[-1] + 1.0 / args.fps
    if not cut_times or cut_times[-1] < video_end - 0.5:
        cut_times.append(video_end)

    # Fallback: cortes fixos se poucos pontos naturais
    if len(cut_times) < 5:
        step = max(2.0, args.min_seg_sec * 2.0)
        cut_times = [0.0]
        t = step
        while t < video_end - 1.0:
            cut_times.append(t)
            t += step
        cut_times.append(video_end)

    # ── Criar e pontuar segmentos ─────────────────────────────────────────
    segments = []
    for i in range(len(cut_times) - 1):
        t_start = cut_times[i]
        t_end   = cut_times[i + 1]
        dur     = t_end - t_start

        if dur < args.min_seg_sec or dur > args.max_seg_sec:
            continue

        seg_frames = [f for f, t in zip(analyzed, frame_times) if t_start <= t < t_end]
        if len(seg_frames) < 2:
            continue

        sc, motives, penalties, metrics = score_segment(seg_frames)

        segments.append({
            'id':       f'seg_{i:04d}',
            'startSec': round(t_start, 3),
            'endSec':   round(t_end,   3),
            'duration': round(dur,     3),
            'score':    sc,
            'motives':  motives,
            'penalties':penalties,
            'selected': False,
            'metrics':  metrics,
        })

    if not segments:
        print(json.dumps({'segments': [], 'selected_segments': [],
                          'duration_sec': round(video_end, 2),
                          'total_selected_sec': 0,
                          'target_sec': args.target_sec}))
        return

    # ── Selecionar trechos para atingir duração alvo ──────────────────────
    segments.sort(key=lambda s: s['score'], reverse=True)

    selected = []
    total_dur = 0.0
    zone_count = {}  # máx 3 trechos por janela de 30s (variedade)

    for seg in segments:
        if total_dur >= args.target_sec:
            break
        zone = int(seg['startSec'] / 30)
        if zone_count.get(zone, 0) >= 3:
            continue
        selected.append(seg)
        total_dur += seg['duration']
        zone_count[zone] = zone_count.get(zone, 0) + 1

    selected.sort(key=lambda s: s['startSec'])
    selected_ids = {s['id'] for s in selected}
    for s in segments:
        s['selected'] = s['id'] in selected_ids

    # Voltar à ordem temporal para exibir na timeline
    segments.sort(key=lambda s: s['startSec'])

    print(json.dumps({
        'segments':          segments,
        'selected_segments': selected,
        'duration_sec':      round(video_end, 2),
        'total_selected_sec':round(total_dur,  2),
        'target_sec':        args.target_sec,
    }))


if __name__ == '__main__':
    main()
