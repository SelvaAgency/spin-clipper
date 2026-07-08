#!/usr/bin/env python3
"""
blur_detect.py — Detects blurry segments in a video via Laplacian variance.

Usage: python3 blur_detect.py <video> [--fps N] [--threshold T] [--min-blur-sec S] [--window W]
Output: JSON to stdout.
"""
import sys, json, subprocess, argparse
import numpy as np

def laplacian_variance(frame_bytes: bytes, w: int, h: int) -> float:
    """Laplacian variance sharpness. Higher = sharper."""
    img = np.frombuffer(frame_bytes, dtype=np.uint8).reshape(h, w).astype(np.float32)
    # Second-order finite differences (discrete Laplacian)
    d2x = img[:, :-2] - 2.0 * img[:, 1:-1] + img[:, 2:]
    d2y = img[:-2, :] - 2.0 * img[1:-1, :] + img[2:, :]
    sz = min(d2x.shape[0], d2y.shape[0]), min(d2x.shape[1], d2y.shape[1])
    lap = d2x[:sz[0], :sz[1]] + d2y[:sz[0], :sz[1]]
    return float(np.var(lap))

def tenengrad(frame_bytes: bytes, w: int, h: int) -> float:
    """Tenengrad sharpness (Sobel gradient energy). Higher = sharper."""
    img = np.frombuffer(frame_bytes, dtype=np.uint8).reshape(h, w).astype(np.float32)
    sx = img[:, 2:] - img[:, :-2]
    sy = img[2:, :] - img[:-2, :]
    sz = min(sx.shape[0], sy.shape[0]), min(sx.shape[1], sy.shape[1])
    return float(np.mean(sx[:sz[0], :sz[1]]**2 + sy[:sz[0], :sz[1]]**2))

def smooth(values: list, window: int) -> list:
    half = window // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--fps",          type=float, default=2.0)
    ap.add_argument("--threshold",    type=float, default=80.0)
    ap.add_argument("--min-blur-sec", type=float, default=0.5)
    ap.add_argument("--window",       type=int,   default=5)
    ap.add_argument("--scale-w",      type=int,   default=320)
    ap.add_argument("--scale-h",      type=int,   default=180)
    ap.add_argument("--metric",       default="laplacian", choices=["laplacian","tenengrad","combined"])
    args = ap.parse_args()

    W, H = args.scale_w, args.scale_h
    frame_size = W * H

    proc = subprocess.Popen([
        "ffmpeg", "-i", args.video,
        "-vf", f"fps={args.fps},scale={W}:{H}",
        "-f", "rawvideo", "-pix_fmt", "gray",
        "-loglevel", "error", "pipe:1",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    raw_scores, times = [], []
    idx = 0
    while True:
        data = proc.stdout.read(frame_size)
        if len(data) < frame_size:
            break
        if args.metric == "tenengrad":
            score = tenengrad(data, W, H)
        elif args.metric == "combined":
            score = (laplacian_variance(data, W, H) + tenengrad(data, W, H)) / 2
        else:
            score = laplacian_variance(data, W, H)
        raw_scores.append(score)
        times.append(idx / args.fps)
        idx += 1
    proc.wait()

    if not raw_scores:
        print(json.dumps({"blurry_segments": [], "all_scores": []}))
        return

    smoothed = smooth(raw_scores, args.window)
    blurry   = [s < args.threshold for s in smoothed]

    segments, in_blur, start_i = [], False, 0
    for i, is_blur in enumerate(blurry):
        if is_blur and not in_blur:
            in_blur, start_i = True, i
        elif not is_blur and in_blur:
            in_blur = False
            dur = times[i] - times[start_i]
            if dur >= args.min_blur_sec:
                avg = sum(raw_scores[start_i:i]) / max(1, i - start_i)
                segments.append({"start_sec": times[start_i], "end_sec": times[i], "duration_sec": dur, "avg_score": avg})
    if in_blur:
        dur = times[-1] - times[start_i]
        if dur >= args.min_blur_sec:
            avg = sum(raw_scores[start_i:]) / max(1, len(raw_scores) - start_i)
            segments.append({"start_sec": times[start_i], "end_sec": times[-1], "duration_sec": dur, "avg_score": avg})

    print(json.dumps({
        "blurry_segments": segments,
        "all_scores": [{"time_sec": t, "score": r, "smoothed": s}
                        for t, r, s in zip(times, raw_scores, smoothed)],
    }))

if __name__ == "__main__":
    main()
