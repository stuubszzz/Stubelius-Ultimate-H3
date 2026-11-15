# Stubelius Ultimate H3 · RTX Video Frame Generation as the frame drawer
"""NVIDIA's RTX Video Frame Generation (the VFX SDK effect in nvidia-vfx 0.2, the package RTX VSR already uses)
draws the in-between frames instead of RIFE: for the Output's frame rate and for de-stutter.

Measured 2026-11-08 against the pack's RIFE 4.7 on held-out frames of real 24 fps clips (keep every 2nd or 4th
frame, draw the rest, compare with the real ones; RTX 5090, 1344x768): HIGH as close as RIFE or closer on live
action (+0.0 to +0.7 dB PSNR) at about RIFE's speed, MEDIUM about 1 dB closer on a 2.5D clip, LOW 3-4x faster and a
little further off.

It runs on RTX 40 series cards and newer only. Asked for anywhere else, or without nvidia-vfx 0.2, RIFE draws the
frames (logged once). NVIDIA's own shot-change detection stays off: the pack keeps hard cuts clean itself, and
inside a shot a detected "cut" would copy the next frame (a held frame, a stutter).
"""
import logging

import torch
from comfy.model_management import get_torch_device

log = logging.getLogger(__name__)

ENGINES = ["RIFE 4.7", "RTX Frame Gen HIGH", "RTX Frame Gen MEDIUM", "RTX Frame Gen LOW"]
DEFAULT = ENGINES[0]            # a workflow saved without the setting keeps what it had: RIFE
NEW_DEFAULT = ENGINES[2]        # a new Output node: RTX Medium (High for fast movement); RIFE where RTX can't run
_WARNED = set()


def rtx_mode(engine):
    """"HIGH" / "MEDIUM" / "LOW" for an RTX choice, else None (RIFE)."""
    if isinstance(engine, str) and engine.startswith("RTX Frame Gen "):
        mode = engine.rsplit(" ", 1)[1]
        return mode if mode in ("HIGH", "MEDIUM", "LOW") else None
    return None


def why_not():
    """None when RTX Frame Generation can run here, else the reason it can't."""
    try:
        import nvvfx
    except Exception as e:                      # noqa: BLE001
        return f"nvidia-vfx isn't installed ({e})"
    if not hasattr(nvvfx, "VideoFrameGeneration"):
        return "nvidia-vfx is older than 0.2 (no frame generation)"
    device = get_torch_device()
    if device.type != "cuda":
        return "it needs an NVIDIA GPU"
    if torch.cuda.get_device_capability(device) < (8, 9):
        return "it needs an RTX 40 series card or newer"
    return None


def usable(engine):
    """The RTX mode to run, or None for RIFE: warns once when RTX was asked for but can't run here."""
    mode = rtx_mode(engine)
    if mode is None:
        return None
    reason = why_not()
    if reason:
        if reason not in _WARNED:
            _WARNED.add(reason)
            log.warning("[StubeliusFrameGen] %s was chosen, but %s: RIFE draws the frames instead", engine, reason)
        return None
    return mode


def draw_between(images, pairs, mode="HIGH"):
    """As stubelius_rife_fps.draw_between: pairs = [(a, b, t)] -> {pair index: frame [H, W, C], on the CPU}.
    The frame at t (0..1) on the way from images[a] to images[b]."""
    if not pairs:
        return {}
    import nvvfx
    device = get_torch_device()
    index = device.index if device.index is not None else torch.cuda.current_device()
    _, h, w, _ = images.shape
    out, on_gpu = {}, {}

    def frame(i):
        if i not in on_gpu:
            if len(on_gpu) > 8:                 # pairs come in order: keep only the last few frames on the GPU
                on_gpu.clear()
            on_gpu[i] = images[i, ..., :3].to(device, torch.float32).movedim(-1, 0).contiguous()
        return on_gpu[i]

    with torch.cuda.device(device), nvvfx.VideoFrameGeneration(
            mode=nvvfx.VideoFrameGeneration.Mode[mode], automatic_shot_change_detection_enabled=False,
            device=index, image_encoding=nvvfx.ImageEncoding.RGB8) as fx:
        fx.input_width, fx.input_height, fx.frame_multiplier = w, h, 2
        fx.load()
        for k, (a, b, t) in enumerate(pairs):
            r = fx.run_at_timestep(frame(a), frame(b), min(max(float(t), 1e-3), 1.0 - 1e-3))
            out[k] = torch.from_dlpack(r.image).clone().movedim(0, -1).clamp(0, 1).cpu()
    return out
