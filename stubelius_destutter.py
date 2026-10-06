"""De-stutter: smooth out frames where H3 held the picture still for a frame while the rest moved.

Some takes move in a fixed rhythm with a held frame in it: "move, move, hold" (every 3rd frame almost a copy
of the one before, the judder of 16 fps footage stretched to 24) or "move, hold" (every 2nd). Measured on a
Speed take (2026-10-07): 108 of 361 steps were holds, three frames apart through the whole clip, while PDMD
on the same seed had none. RIFE at 48/60 fps doesn't fix it: it only splits each jump in two.

The fix finds the holds in the motion between frames: a step much smaller than the steps on both sides of it,
in a stretch where things move. A held picture is one pose shown twice. It is given the time halfway between
its two frames, and both frames are drawn again by RIFE on the way between that pose and its neighbours, so
the motion advances evenly. Every other frame is left as it was rendered, the frame count stays the same
(the sound stays in sync), and hard cuts are never drawn across.

  mode "auto": only takes that judder (holds on at least 8% of the moving steps); "on": every hold found;
  "off": nothing.
"""
import logging
import math

import torch
from comfy.model_management import get_torch_device, soft_empty_cache

from .stubelius_rife_fps import _hard_cuts, draw_between

log = logging.getLogger(__name__)

MODES = ["auto", "on", "off"]
HOLD_RATIO = 0.5        # a step under half the mean of its two neighbours is a hold
MOTION_FLOOR = 1.5      # ... where those neighbours move: mean luma change (0-255 at 128x72) above this
AUTO_SHARE = 0.08       # auto: holds on at least 8% of the moving steps
AUTO_MIN = 3


def steps(images, device=None):
    """Mean luma change between each frame and the next (0-255, measured at 128x72): N-1 values."""
    device = device or get_torch_device()
    luma = torch.tensor([0.299, 0.587, 0.114], device=device)
    small = []
    with torch.inference_mode():
        for s in range(0, images.shape[0], 64):
            x = images[s:s + 64, ..., :3].to(device, torch.float32)
            y = (x * luma).sum(-1, keepdim=True).movedim(-1, 1)
            small.append(torch.nn.functional.interpolate(y, size=(72, 128), mode="area")[:, 0].cpu())
    g = torch.cat(small) * 255
    return [float(v) for v in (g[1:] - g[:-1]).abs().mean(dim=(1, 2))]


def find_holds(d, cuts=()):
    """Steps j (frame j -> j+1) where the picture held: much smaller than both neighbours, in motion.
    Returns (holds, moving steps)."""
    holds, moving = [], 0
    for j in range(1, len(d) - 1):
        if j in cuts or (j - 1) in cuts or (j + 1) in cuts:
            continue
        around = (d[j - 1] + d[j + 1]) / 2
        if around < MOTION_FLOOR:
            continue
        moving += 1
        if d[j] < HOLD_RATIO * around:
            holds.append(j)
    return holds, moving


def plan(n, holds, cuts=()):
    """Which frames to draw again, and from what: [(frame k, frame a, frame b, t)], RIFE between a and b at t.

    Frames joined by a hold are one pose. A pose of several frames sits at the mean of its frame times;
    each of its frames is drawn on the way from the pose before to it, or from it to the pose after."""
    held = set(holds)
    groups, cur = [], [0]
    for k in range(1, n):
        if (k - 1) in held:
            cur.append(k)
        else:
            groups.append(cur)
            cur = [k]
    groups.append(cur)
    times = [sum(g) / len(g) for g in groups]
    tasks = []
    for gi, g in enumerate(groups):
        if len(g) == 1:
            continue
        for k in g:
            if k < times[gi] and gi > 0:
                a, b, ta, tb = groups[gi - 1][0], g[0], times[gi - 1], times[gi]
            elif k > times[gi] and gi < len(groups) - 1:
                a, b, ta, tb = g[0], groups[gi + 1][0], times[gi], times[gi + 1]
            else:
                continue              # the pose's own time, or the clip's edge: as it was
            # across a hard cut: keep the frame (a cut stays a clean cut)
            if any(a <= c < b for c in cuts):
                continue
            tasks.append((k, a, b, (k - ta) / (tb - ta)))
    return tasks


def destutter(images, mode="auto", label="", ckpt_name="rife47.pth"):
    """(images, report): the frames with their holds drawn again, or as they were."""
    n = images.shape[0]
    if mode == "off" or n < 4:
        return images, "off"
    device = get_torch_device()
    d = steps(images, device)
    cuts = _hard_cuts(images, device)
    holds, moving = find_holds(d, cuts)
    share = len(holds) / moving if moving else 0.0
    if not holds or (mode == "auto" and (len(holds) < AUTO_MIN or share < AUTO_SHARE)):
        report = f"smooth already ({len(holds)} held frame(s) in {moving} moving steps)"
        log.info("[StubeliusDeStutter] %s%s", label, report)
        return images, report
    tasks = plan(n, holds, cuts)
    out = images.clone()
    for k, frame in draw_between(images, [(a, b, t) for _, a, b, t in tasks], ckpt_name).items():
        out[tasks[k][0]] = frame
    soft_empty_cache()
    gaps = [b - a for a, b in zip(holds, holds[1:])]
    rhythm = max(set(gaps), key=gaps.count) if gaps else 0
    report = (f"{len(holds)} held frame(s) in {moving} moving steps"
              + (f", one every {rhythm} frames" if rhythm and gaps.count(rhythm) >= len(gaps) / 2 else "")
              + f": {len(tasks)} frames drawn again")
    log.info("[StubeliusDeStutter] %s%s", label, report)
    return out, report
