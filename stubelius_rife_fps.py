"""Stubelius RIFE to FPS — frame interpolation to any target frame rate in one pass.

RIFE's IFNet accepts any in-between point t in (0, 1), not just k/multiplier. Every output
frame k sits at source position k * source_fps / target_fps; frames landing on a source
frame are copied, the rest are drawn by RIFE at that exact point. 24 -> 60 therefore draws
1.5 new frames per gap instead of the 4 that an x5-then-halve route needs. Frames are written
straight into the output, so only the final frames are held in memory. Hard cuts are not
interpolated: in-between frames there take the nearest source frame, so a cut stays a clean
cut instead of a two-frame morph between the shots. Output length matches the input
duration, so audio stays in sync. Reuses ComfyUI-Frame-Interpolation's RIFE checkpoints and loader.
"""
import glob
import logging
import math
import os
import sys

import torch

import folder_paths
from comfy.model_management import get_torch_device, soft_empty_cache

log = logging.getLogger(__name__)

CKPTS = ["rife47.pth", "rife49.pth", "rife417.pth", "rife426.pth"]
_MODELS = {}
# Hard cut = mean luma change between two frames (0-255, measured at 128x72) above both
# CUT_MIN_CHANGE and CUT_X_MEDIAN x the clip's median change, and CUT_X_NEIGHBOUR x the
# change on either side: a cut is one isolated jump; a fast pan is high motion over several
# frames and still gets interpolated. (Measured: a cut 45, fast motion 13, median 5.)
CUT_MIN_CHANGE, CUT_X_MEDIAN, CUT_X_NEIGHBOUR = 20.0, 4.0, 2.5


def _vfi_pack():
    for root in folder_paths.get_folder_paths("custom_nodes"):
        for d in glob.glob(os.path.join(root, "*")):
            if os.path.isfile(os.path.join(d, "vfi_models", "rife", "rife_arch.py")):
                if d not in sys.path:
                    sys.path.insert(0, d)
                return d
    raise RuntimeError("[StubeliusRIFEToFPS] needs ComfyUI-Frame-Interpolation (RIFE) installed.")


def _model(ckpt_name):
    if ckpt_name not in _MODELS:
        _vfi_pack()
        from vfi_utils import load_file_from_github_release
        from vfi_models.rife import CKPT_NAME_VER_DICT
        from vfi_models.rife.rife_arch import IFNet
        arch_ver = CKPT_NAME_VER_DICT[ckpt_name]
        net = IFNet(arch_ver=arch_ver)
        net.load_state_dict(torch.load(load_file_from_github_release("rife", ckpt_name), weights_only=False))
        _MODELS[ckpt_name] = (net.eval().to(get_torch_device()), arch_ver)
    return _MODELS[ckpt_name]


def _hard_cuts(images, device):
    """Source gaps j (frame j -> j+1) that are hard cuts."""
    n = images.shape[0]
    if n < 3:
        return set()
    luma = torch.tensor([0.299, 0.587, 0.114], device=device)
    small = []
    with torch.inference_mode():
        for s in range(0, n, 64):
            x = images[s:s + 64, ..., :3].to(device, torch.float32)
            y = (x * luma).sum(-1, keepdim=True).movedim(-1, 1)
            small.append(torch.nn.functional.interpolate(y, size=(72, 128), mode="area")[:, 0].cpu())
    g = torch.cat(small) * 255
    d = (g[1:] - g[:-1]).abs().mean(dim=(1, 2))
    threshold = max(CUT_MIN_CHANGE, CUT_X_MEDIAN * float(d.median()))
    padded = torch.cat([d.new_zeros(1), d, d.new_zeros(1)])
    neighbours = torch.maximum(padded[:-2], padded[2:])
    return {int(j) for j in torch.nonzero((d > threshold) & (d > CUT_X_NEIGHBOUR * neighbours)).flatten()}


class StubeliusRIFEToFPS:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "source_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.001}),
                "target_fps": ("FLOAT", {"default": 60.0, "min": 1.0, "max": 240.0, "step": 1.0,
                    "tooltip": "Final frame rate. At or below the source rate the frames pass through untouched."}),
                "ckpt_name": (CKPTS, {"default": "rife47.pth"}),
                "fast_mode": ("BOOLEAN", {"default": True}),
                "ensemble": ("BOOLEAN", {"default": True}),
                "batch_size": ("INT", {"default": 8, "min": 1, "max": 64,
                    "tooltip": "In-between frames drawn per GPU call."}),
            }
        }

    RETURN_TYPES = ("IMAGE", "FLOAT")
    RETURN_NAMES = ("images", "fps")
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self, images, source_fps, target_fps, ckpt_name, fast_mode, ensemble, batch_size):
        n_in = images.shape[0]
        if target_fps <= source_fps + 1e-6 or n_in < 2:
            return (images, float(source_fps))

        device = get_torch_device()
        cuts = _hard_cuts(images, device)
        ratio = source_fps / target_fps
        n_out = int(round(n_in / ratio))
        plan = []            # per output frame: ("src", i) or ("mid", i, t)
        for k in range(n_out):
            p = min(k * ratio, n_in - 1)
            i = math.floor(p + 1e-6)
            t = p - i
            if t < 1e-6 or i >= n_in - 1:
                plan.append(("src", i))
            elif i in cuts:
                plan.append(("src", i if t < 0.5 else i + 1))
            else:
                plan.append(("mid", i, t))
        tasks = [(k, e[1], e[2]) for k, e in enumerate(plan) if e[0] == "mid"]

        net, arch_ver = _model(ckpt_name)
        if arch_ver == "4.26":
            ensemble = False
            scale_list = [16, 8, 4, 2, 1]
        else:
            scale_list = [8, 4, 2, 1]

        _, h, w, c = images.shape
        out = torch.empty((n_out, h, w, c), dtype=torch.float32)
        for k, e in enumerate(plan):
            if e[0] == "src":
                out[k] = images[e[1]]
        frames = images.permute(0, 3, 1, 2)          # N,H,W,C -> N,C,H,W, values 0..1
        pad_h, pad_w = (32 - h % 32) % 32, (32 - w % 32) % 32
        with torch.inference_mode():
            for s in range(0, len(tasks), batch_size):
                chunk = tasks[s:s + batch_size]
                f0 = torch.stack([frames[i] for _, i, _ in chunk]).to(device)
                f1 = torch.stack([frames[i + 1] for _, i, _ in chunk]).to(device)
                if pad_h or pad_w:
                    f0 = torch.nn.functional.pad(f0, (0, pad_w, 0, pad_h), mode="replicate")
                    f1 = torch.nn.functional.pad(f1, (0, pad_w, 0, pad_h), mode="replicate")
                ts = torch.tensor([t for _, _, t in chunk], device=device).view(-1, 1, 1, 1)
                mid = net(f0, f1, ts, scale_list, fast_mode, ensemble).clamp(0, 1)[:, :, :h, :w]
                mid = mid.movedim(1, -1).cpu()
                for (k, _, _), m in zip(chunk, mid):
                    out[k] = m
        soft_empty_cache()

        log.info("[StubeliusRIFEToFPS] %d frames @ %.3g fps -> %d frames @ %.3g fps (%d drawn by RIFE)%s",
                 n_in, source_fps, n_out, target_fps, len(tasks),
                 "; hard cut(s) kept clean at " + ", ".join(f"{(j + 1) / source_fps:.2f}s" for j in sorted(cuts))
                 if cuts else "")
        return (out, float(target_fps))


NODE_CLASS_MAPPINGS = {"StubeliusRIFEToFPS": StubeliusRIFEToFPS}
NODE_DISPLAY_NAME_MAPPINGS = {"StubeliusRIFEToFPS": "Stubelius RIFE to FPS"}
