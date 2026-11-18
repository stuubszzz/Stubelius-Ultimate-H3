# Stubelius Ultimate H3 · RelayVSR: the finished take upscaled 2x or 4x by RelayVSR, in pieces
"""RelayVSR: a fast video upscaler that keeps the take as it is (the face, the motion, the sound).

RelayVSR (kopperx/RelayVSR, Apache-2.0) runs a Wan 2.2 5B model one step on every 15th frame of the low-res video,
and a small "Flash" decoder then builds every frame at 2x or 4x from those keyframes and the low-res frames
themselves. ComfyUI has it built in (0.45 and newer): RelayVSRConditioning -> KSampler (1 step, CFG 1, euler,
simple, the conditioning as both positive and negative) -> VSR Decode, the graph of ComfyUI's own template. The
2x model is LightX2V's retrain for MiniMax H3; the 4x one is the original.

The Flash decoder works window by window, from one keyframe to the next, each window on its own (fresh history,
the keyframe latents on either side). So the keyframes are sampled for the whole take at once, and the decode runs
in pieces of whole windows: a piece of frames k_a..k_b with the latents a..b decodes exactly what one long decode
would (the piece's first frame, a keyframe the piece before already gave, is dropped). Each piece is brought to the
finished size right away, so a 4x decode (198 MB a frame from 768p) never sits in RAM whole: in one decode the
498 frames of an 18 s take would be about 99 GB at 4x.

Weights: huggingface.co/Comfy-Org/RelayVSR. models/diffusion_models: relayvsr_x2_lightx2v_int8_convrot.safetensors /
relayvsr_x4_int8_convrot.safetensors; models/vae: relayvsr_flash_vae_x2_fp32.safetensors /
relayvsr_flash_vae_x4_fp32.safetensors. The model and the decoder must be of the same factor.
"""
import logging
import os
import re

import torch

log = logging.getLogger(__name__)

NAMES = {"RelayVSR 2x": 2, "RelayVSR 4x": 4}     # the Output node's upscaler choices -> the model's factor
DETAIL = 1.0                    # VSR Decode's own default: the decoder's full output
KEYFRAME_INTERVAL = 15          # comfy.ldm.wan.model_vsr.RELAY_KEYFRAME_INTERVAL
PIECE_BYTES = 4e9               # the largest piece of decoded frames held at the model's size before the fit
SOURCE = "huggingface.co/Comfy-Org/RelayVSR"
FILES = {
    2: ("relayvsr_x2_lightx2v_int8_convrot.safetensors", "relayvsr_flash_vae_x2_fp32.safetensors", "5.2 GB"),
    4: ("relayvsr_x4_int8_convrot.safetensors", "relayvsr_flash_vae_x4_fp32.safetensors", "5.2 GB"),
}
NODES = ("RelayVSRConditioning", "VSRDecode")

_LOADED = {}    # factor -> (key, model, vae): one factor kept loaded, the model is 5 GB


def help_text(factor):
    model, vae, size = FILES[factor]
    return (f"RelayVSR {factor}x needs its two files from {SOURCE}: {model} ({size}) into models/diffusion_models and "
            f"{vae} (0.13 GB) into models/vae, and ComfyUI 0.45 or newer (its RelayVSR nodes are built in).")


def _factor_in(name, factor):
    # x2 / x4 as its own token: relayvsr_x2_... yes, lightx2v no
    return re.search(rf"(^|[^0-9a-z])x{factor}([^0-9]|$)", os.path.basename(name).lower()) is not None


def file_names(factor):
    """(model, decoder) names in models/diffusion_models and models/vae for this factor, or None where missing.
    For 2x LightX2V's H3 retrain comes first."""
    import folder_paths
    models = [n for n in folder_paths.get_filename_list("diffusion_models")
              if "relayvsr" in n.lower() and _factor_in(n, factor)]
    vaes = [n for n in folder_paths.get_filename_list("vae")
            if "relayvsr" in n.lower() and "flash" in n.lower() and _factor_in(n, factor)]
    models.sort(key=lambda n: ("lightx2v" not in n.lower(), n.lower()))
    vaes.sort(key=str.lower)
    return (models[0] if models else None), (vaes[0] if vaes else None)


def ready(factor):
    from .stubelius_h3_pipeline import _cls
    return all(_cls(n) is not None for n in NODES) and None not in file_names(factor)


def _models(factor):
    from .stubelius_h3_pipeline import _cls, _run
    if any(_cls(n) is None for n in NODES):
        raise RuntimeError(f"[StubeliusH3Finish] {help_text(factor)} This ComfyUI has no RelayVSR nodes: update it.")
    model_name, vae_name = file_names(factor)
    if model_name is None or vae_name is None:
        raise RuntimeError(f"[StubeliusH3Finish] {help_text(factor)} Missing: "
                           + ", ".join(n for n, f in (("the model", model_name), ("the decoder", vae_name)) if f is None)
                           + ".")
    import folder_paths
    paths = (folder_paths.get_full_path("diffusion_models", model_name), folder_paths.get_full_path("vae", vae_name))
    key = tuple((p, os.path.getmtime(p) if p and os.path.exists(p) else 0) for p in paths)
    held = _LOADED.get(factor)
    if held and held[0] == key:
        return held[1], held[2]
    _LOADED.clear()     # the other factor's 5 GB goes first
    model = _run("UNETLoader", unet_name=model_name, weight_dtype="default")[0]
    vae = _run("VAELoader", vae_name=vae_name)[0]
    _LOADED[factor] = (key, model, vae)
    log.info("[StubeliusH3Finish] RelayVSR %dx: %s + %s", factor, model_name, vae_name)
    return model, vae


def keyframes(frames):
    """comfy.ldm.wan.model_vsr.relay_keyframes: every 15th frame and the last one."""
    return list(range(0, frames - 1, KEYFRAME_INTERVAL)) + [frames - 1]


def pieces(frames, frame_bytes, budget=PIECE_BYTES):
    """[(a, b)] keyframe index ranges, whole windows each, every piece's frames (k_a..k_b) within `budget` bytes at
    the model's size where a window allows it. Consecutive pieces share their boundary keyframe."""
    keys = keyframes(frames)
    if len(keys) == 1:
        return [(0, 0)]
    per = max(1, int(budget // max(1, (KEYFRAME_INTERVAL + 1) * frame_bytes)))
    return [(a, min(a + per, len(keys) - 1)) for a in range(0, len(keys) - 1, per)]


def out_size(images, short_side, factor):
    """(width, height): the finished size when the factor reaches it, else the model's own size (factor x the take);
    the pack's RTX VSR then takes it the rest of the way."""
    from .stubelius_h3_pipeline import _short, _target_size
    h, w = int(images.shape[1]), int(images.shape[2])
    if short_side and short_side <= factor * _short(images) + 0.5:
        return _target_size(images, short_side)
    return w * factor, h * factor


def upscale(images, short_side, factor, detail=DETAIL, budget=PIECE_BYTES):
    """The take (IMAGE, 24 fps frames) through RelayVSR at `factor`, brought to `short_side` when the factor reaches it
    (a downscale, bicubic), else left at factor x its size. The keyframes are sampled for the whole take, the frames
    decoded in pieces."""
    from .stubelius_h3_pipeline import _fit, _run
    model, vae = _models(factor)
    n, h, w = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    width, height = out_size(images, short_side, factor)
    positive, latent = _run("RelayVSRConditioning", model=model, images=images)[:2]
    samples = _run("KSampler", model=model, seed=0, steps=1, cfg=1.0, sampler_name="euler", scheduler="simple",
                   positive=positive, negative=positive, latent_image=latent, denoise=1.0)[0]["samples"]
    keys = keyframes(n)
    if samples.shape[2] != len(keys):
        raise RuntimeError(f"[StubeliusH3Finish] RelayVSR sampled {samples.shape[2]} keyframes for {n} frames, "
                           f"{len(keys)} expected: this ComfyUI's RelayVSR changed, the pack needs an update.")
    out = torch.empty((n, height, width, int(images.shape[3])), dtype=images.dtype)
    plan = pieces(n, h * factor * w * factor * 3 * 4, budget)
    for a, b in plan:
        f0, f1 = keys[a], keys[b]
        part = _run("VSRDecode", vae=vae, samples={"samples": samples[:, :, a:b + 1]}, images=images[f0:f1 + 1],
                    detail=float(detail))[0]
        if a:
            part = part[1:]             # its first frame is the keyframe the piece before already gave
            f0 += 1
        if part.shape[0] != f1 + 1 - f0:
            raise RuntimeError(f"[StubeliusH3Finish] RelayVSR decoded {part.shape[0]} frames for {f1 + 1 - f0}.")
        out[f0:f1 + 1] = _fit(part, min(height, width), size=(width, height))
        del part
    del samples
    log.info("[StubeliusH3Finish] RelayVSR %dx: %d frames %dx%d -> %dx%d, %d piece%s, detail %.2f", factor, n, w, h,
             width, height, len(plan), "" if len(plan) == 1 else "s", float(detail))
    return out
