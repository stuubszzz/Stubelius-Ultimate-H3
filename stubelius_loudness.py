# Stubelius Ultimate H3 · Loudness (LUFS) of the finished video
"""Integrated loudness (LUFS, ITU-R BS.1770-4) of a finished video's sound, for the Output window.

K-weighting (the standard's high shelf and high pass, RBJ biquads at any sample rate), 400 ms blocks every
100 ms, the absolute gate at -70 LUFS and the relative gate 10 LU under the gated mean.
"""
import math

import numpy as np


def _biquads(rate):
    """The two K-weighting stages for this sample rate: [(b, a), (b, a)]."""
    out = []
    # stage 1: high shelf, +4 dB above about 1.5 kHz
    gain, q, fc = 4.0, 1 / math.sqrt(2), 1500.0
    big_a = 10 ** (gain / 40)
    w0 = 2 * math.pi * fc / rate
    alpha = math.sin(w0) / (2 * q)
    cos = math.cos(w0)
    b = [big_a * ((big_a + 1) + (big_a - 1) * cos + 2 * math.sqrt(big_a) * alpha),
         -2 * big_a * ((big_a - 1) + (big_a + 1) * cos),
         big_a * ((big_a + 1) + (big_a - 1) * cos - 2 * math.sqrt(big_a) * alpha)]
    a = [(big_a + 1) - (big_a - 1) * cos + 2 * math.sqrt(big_a) * alpha,
         2 * ((big_a - 1) - (big_a + 1) * cos),
         (big_a + 1) - (big_a - 1) * cos - 2 * math.sqrt(big_a) * alpha]
    out.append(([x / a[0] for x in b], [x / a[0] for x in a]))
    # stage 2: high pass at about 38 Hz
    q, fc = 0.5, 38.0
    w0 = 2 * math.pi * fc / rate
    alpha = math.sin(w0) / (2 * q)
    cos = math.cos(w0)
    b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
    a = [1 + alpha, -2 * cos, 1 - alpha]
    out.append(([x / a[0] for x in b], [x / a[0] for x in a]))
    return out


def lufs(waveform, rate):
    """Integrated loudness of `waveform` ([channels, samples] or [1, channels, samples], -1..1) in LUFS,
    or None when it is too short or silent."""
    from scipy.signal import lfilter
    x = np.asarray(waveform.detach().cpu().float().numpy() if hasattr(waveform, "detach") else waveform, dtype=np.float64)
    if x.ndim == 3:
        x = x[0]
    if x.ndim == 1:
        x = x[None]
    x = x[:2]
    rate = int(rate)
    block, step = int(0.4 * rate), int(0.1 * rate)
    if x.shape[-1] < block:
        return None
    for b, a in _biquads(rate):
        x = lfilter(b, a, x, axis=-1)
    n = 1 + (x.shape[-1] - block) // step
    power = np.stack([np.mean(x[:, i * step:i * step + block] ** 2, axis=-1) for i in range(n)])   # [blocks, ch]
    total = power.sum(axis=-1)
    with np.errstate(divide="ignore"):
        loud = -0.691 + 10 * np.log10(total)
    keep = loud > -70.0
    if not keep.any():
        return None
    gated = -0.691 + 10 * np.log10(power[keep].mean(axis=0).sum())
    keep &= loud > gated - 10.0
    if not keep.any():
        return None
    return float(-0.691 + 10 * np.log10(power[keep].mean(axis=0).sum()))
