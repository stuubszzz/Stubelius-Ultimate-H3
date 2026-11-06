# Stubelius Ultimate H3 · Regenerate 2K: the take rendered again at 1440p by NVlabs' refiner LoRA
"""Regenerate 2K: the finished take rendered again at 1440p by the Open-H3-Regenerate-2K refiner LoRA.

The refiner was trained to regenerate a small H3 draft at 2560x1440 in three Euler steps: the draft's latent is
upscaled to 2K, noised to sigma 0.909375 ((1 - s) * upscaled + s * noise), then denoised on the sigmas 0.909375,
0.857143, 0.666667, 0 at CFG 1, with the LoRA at scale 1.0 (its strength is folded into its weights).

The pack's polish already runs that shape: a pass that noises the upscaled latent to the schedule's first sigma,
then a pass without new noise over the schedule, a BasicGuider (CFG 1), and the take's own sound locked. So this
finish is the polish with that schedule, Euler, the refiner LoRA on top of each chunk's own checkpoint and
LoRAs, and the learned any-scale latent upscaler to a 1440p short side. It re-renders the picture only, chunk by
chunk (stubelius_polish.py), so the take keeps its sound and its length.

Weights: huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K-LoRA (MiniMax H3 Community License), anywhere
in models/loras. They are published in Diffusers names; stubelius_lora_convert makes them ComfyUI's.
"""
import logging

import torch

log = logging.getLogger(__name__)

NAME = "Regenerate 2K"          # the Output node's upscaler choice
SIGMAS = (0.909375, 0.857143, 0.666667, 0.0)
SAMPLER = "euler"
SHORT_SIDE = 1440
MAX_SCALE = 3.0                 # Speed's ~480p to 1440p; the any-scale upscaler makes the latent at any size
SOURCE = "huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K-LoRA"


def lora_name():
    """The refiner LoRA's name in models/loras, or None."""
    import folder_paths
    names = sorted(n for n in folder_paths.get_filename_list("loras")
                   if "regenerate_2k" in n.lower().replace("-", "_") and n.lower().endswith(".safetensors"))
    return next((n for n in names if "refiner" in n.lower()), names[0] if names else None)


def ready():
    return lora_name() is not None


def sigmas():
    return torch.tensor(SIGMAS, dtype=torch.float32)


def scale_for(short_px):
    """How much bigger than the take the regeneration renders: to a 1440p short side."""
    return max(1.0, min(MAX_SCALE, SHORT_SIDE / float(short_px)))


def method():
    """How the take's latent is made 2K before the three steps: the learned any-scale upscaler, or the learned
    2x one when that isn't installed (then the frames come out 2x and are fitted to 1440p after)."""
    from .muse_minimax_refine import H3_ANY_SCALE, MUSE_GOLD_LEARNED, h3_any_scale_ready
    if h3_any_scale_ready():
        return H3_ANY_SCALE
    log.warning("[StubeliusRegen] the H3 latent upscaler (Comfyui_Minimax_h3_latent_Upscaler and "
                "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors in models/latent_upscale_models) isn't "
                "installed: the take is made 2x bigger with the learned 2x upscaler instead, then fitted to 1440p.")
    return MUSE_GOLD_LEARNED


def plan(short_px):
    """(upscale method, scale) for a take whose short side is `short_px`: the any-scale upscaler straight to
    1440p, or the learned 2x one at 2x."""
    from .muse_minimax_refine import H3_ANY_SCALE
    how = method()
    return how, (scale_for(short_px) if how == H3_ANY_SCALE else 2.0)


def state_dict():
    """The refiner LoRA in ComfyUI's H3 names, as bf16.

    As published it is 8.3 GB of FP32 (rank 384 on 312 linears); with q/k/v fused for ComfyUI (A stacked, B
    block-diagonal) it would hold 12 GB, and 6 GB as bf16, which ComfyUI patches in at float32 anyway. Loaded once
    per finish, not kept in RAM between runs."""
    import folder_paths
    import comfy.utils
    from .stubelius_lora_convert import convert, is_diffusers_h3
    name = lora_name()
    if name is None:
        raise RuntimeError(f"[StubeliusRegen] '{NAME}' needs NVlabs' refiner LoRA in models/loras: "
                           f"open_h3_regenerate_2k_refiner_lora.safetensors from {SOURCE}. Download it there, "
                           "or pick RTX VSR or DLSS5 + Color Lock.")
    sd, metadata = comfy.utils.load_torch_file(folder_paths.get_full_path("loras", name), safe_load=True,
                                               return_metadata=True)
    for k in list(sd):
        if sd[k].is_floating_point():
            sd[k] = sd[k].to(torch.bfloat16)      # one tensor at a time: never two full copies
    if is_diffusers_h3(sd):
        sd = convert(sd, metadata)
    log.info("[StubeliusRegen] refiner LoRA %s: %d tensors, %.1f GB", name, len(sd),
             sum(v.numel() * v.element_size() for v in sd.values()) / 1e9)
    return sd


def with_lora(model, sd):
    """`model` with the refiner LoRA on top, at its published scale 1.0."""
    import comfy.sd
    return comfy.sd.load_lora_for_models(model, None, sd, 1.0, 0)[0]
