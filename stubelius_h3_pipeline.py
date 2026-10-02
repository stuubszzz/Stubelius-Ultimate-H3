"""Stubelius H3 pipeline nodes: Setup, Models and Finish.

Setup   decides HOW the video is generated (mode presets, seed count, optional overrides).
Output  decides what comes OUT: final resolution (Speed up to 2K, Hybrid and Quality up to 4K; the
        mode decides how it gets there), final FPS, upscaler and the Quality polish. It feeds only Finish, never the Director, so changing it after a seed
        hunt re-runs only the finish.
Models  loads the H3 checkpoints, text encoder and VAEs, and applies the speedup LoRA, extra
        LoRAs and speed/memory patches. It returns a lazy bundle: a checkpoint is only loaded
        when the Director actually needs it (ref2va for Reference, fl2va for First/Last Frame
        and for Extend), so no model switch is needed in the graph.
Finish  turns the Director's takes into the final video with the Output settings: picks the
        WINNER, runs the Quality polish, RIFE to the final FPS, and the upscale (RTX VSR or
        DLSS5 + Color Lock). WINNER is the only thing left to choose after a seed hunt; the
        Quality polish is memoised, so FPS/upscaler changes don't repeat it either.
Speed/memory patches and the DLSS5/VSR/GGUF loaders are called by class name at runtime and
are skipped (or reported clearly) when their pack isn't installed.
"""
import logging
import os
import types

import comfy.samplers
import comfy.sd
import folder_paths
import torch

from .muse_minimax_director import _execute_comfy_node, _unpack_node_result

log = logging.getLogger(__name__)

MODES = ["Speed", "Hybrid", "Quality"]
PRESETS = {
    "Speed":   dict(steps=8,  sampler="res_multistep", scheduler="simple", megapixels=0.4,  speedup_strength=1.0),
    "Hybrid":  dict(steps=10, sampler="euler",         scheduler="beta",   megapixels=0.5,  speedup_strength=0.75),
    "Quality": dict(steps=20, sampler="euler",         scheduler="beta",   megapixels=0.98, speedup_strength=0.0),
}
UPSCALERS = ["RTX VSR", "DLSS5 + Color Lock"]
DLSS5_FACTORS = {1.5: "1.5x (Quality)", 1.724: "1.724x (Balanced)", 2.0: "2x (Performance)",
                 3.0: "3x (Ultra Performance)"}
VSR_MAX_SCALE = 4.0     # RTX VSR per pass; more (Speed to 4K = 4.5x) runs in two passes
POLISH_ABOVE = 1.1      # Quality polishes when the chosen size is >10% above what it rendered
POLISH_SCALES = {"1.5x": 1.5, "2x": 2.0}    # how much bigger than the take the polish renders
SOURCE_FPS = 24.0
# Final resolution: the value is the exact short side in pixels (None = keep the render size).
# js/stubelius_h3_setup.js narrows the list to the sizes the Setup mode offers.
RESOLUTIONS = {
    "native (no upscale)": None,
    "720p": 720,
    "1080p": 1080,
    "2K (1440p)": 1440,
    "4K (2160p)": 2160,
}
SIZES_BY_MODE = {
    "Speed":   ["native (no upscale)", "720p", "1080p", "2K (1440p)"],             # ~480p render: 2K at most
    "Hybrid":  list(RESOLUTIONS),
    "Quality": ["native (no upscale)", "1080p", "2K (1440p)", "4K (2160p)"],       # native is ~768p already
}
# a size the mode doesn't offer -> the one it gets instead (switching mode, or an older workflow)
SIZE_FALLBACK = {"Speed": {"4K (2160p)": "2K (1440p)"}, "Quality": {"720p": "native (no upscale)"}}


def _cls(name):
    from nodes import NODE_CLASS_MAPPINGS
    return NODE_CLASS_MAPPINGS.get(name)


def _run(name, **kwargs):
    cls = _cls(name)
    if cls is None:
        raise RuntimeError(f"[Stubelius] node '{name}' is not installed")
    return _unpack_node_result(_execute_comfy_node(cls, **kwargs))


def _patch(model, name, label, **kwargs):
    """Apply an optional model patch node; skip with a warning if its pack is missing."""
    if _cls(name) is None:
        log.warning("[StubeliusH3Models] %s skipped: node '%s' not installed", label, name)
        return model
    return _run(name, model=model, **kwargs)[0]


def _first_match(options, *needles):
    for needle in needles:
        for o in options:
            if needle in o.lower():
                return o
    return options[0] if options else ""


def _gguf(folder):
    try:
        return [f for f in folder_paths.get_filename_list(folder) if f.lower().endswith(".gguf")]
    except Exception:
        return []


# ---------------------------------------------------------------- Setup

class StubeliusH3Setup:
    """Choosing a mode fills steps/sampler/scheduler/megapixels/speedup strength with that mode's
    preset (js/stubelius_h3_setup.js reads PRESETS from the 'presets' option below); the widgets
    always hold the real values used, so any of them can be tweaked afterwards."""

    @classmethod
    def INPUT_TYPES(cls):
        h = PRESETS["Hybrid"]
        return {
            "required": {
                "mode": (MODES, {"default": "Hybrid", "presets": PRESETS, "tooltip":
                    "HOW the video is made; the Output node decides the size (Speed up to 2K, Hybrid and "
                    "Quality up to 4K). Picking a mode fills the settings below with its preset. Speed: 0.4 MP, "
                    "8 steps, turbo 1.0. Hybrid: 0.5 MP, 10 steps, turbo 0.75. Quality: 0.98 MP, 20 steps, "
                    "no turbo, plus a 2x polish when the Output size is above what it rendered."}),
                "seeds": ("INT", {"default": 1, "min": 1, "max": 4, "tooltip":
                    "How many full videos (with sound) to render. Pick one with WINNER on the Finish node "
                    "(WINNER 0 = hold after the seeds)."}),
                "steps": ("INT", {"default": h["steps"], "min": 1, "max": 100}),
                "sampler": (list(comfy.samplers.KSampler.SAMPLERS), {"default": h["sampler"]}),
                "scheduler": (list(comfy.samplers.KSampler.SCHEDULERS), {"default": h["scheduler"]}),
                "megapixels": ("FLOAT", {"default": h["megapixels"], "min": 0.1, "max": 4.0, "step": 0.02,
                    "tooltip": "Render size before the Finish upscale."}),
                "speedup_lora_strength": ("FLOAT", {"default": h["speedup_strength"], "min": 0.0, "max": 2.0,
                    "step": 0.05, "tooltip": "Strength of the speedup LoRA chosen on the Models node. "
                                             "0 = off (Quality preset)."}),
            }
        }

    RETURN_TYPES = ("H3_SETUP", "INT")
    RETURN_NAMES = ("setup", "mode")
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self, mode, seeds, steps, sampler, scheduler, megapixels, speedup_lora_strength):
        p = dict(mode=mode, steps=steps, sampler=sampler, scheduler=scheduler, megapixels=megapixels,
                 speedup_strength=speedup_lora_strength, seed_count=max(1, min(4, seeds)))
        log.info("[StubeliusH3Setup] %s", p)
        return (p, MODES.index(mode) + 1)


# ---------------------------------------------------------------- Output

def _polish_methods():
    """Polish upscale methods as shown on the Output node -> the value the Refine code expects.
    The learned upscaler keeps its old name inside the pack, so saved Director/Refine workflows
    still load; the Output node shows it without the "gold" label."""
    from .muse_minimax_refine import MuseMinimaxRefine, MUSE_GOLD_LEARNED
    methods = MuseMinimaxRefine.INPUT_TYPES()["required"]["two_stage_upscale_method"][0]
    return {("learned model (2x)" if m == MUSE_GOLD_LEARNED else m): m for m in methods}


class StubeliusH3Output:
    """What comes out: chosen up front next to the Setup, used only by Finish. It never feeds the
    Director, so changing it after a seed hunt re-runs only the finish."""

    @classmethod
    def INPUT_TYPES(cls):
        methods = list(_polish_methods())
        return {
            "required": {
                "mode": ("INT", {"forceInput": True, "tooltip": "From the Setup node."}),
                "final_resolution": (list(RESOLUTIONS), {
                    "default": "1080p", "per_mode": SIZES_BY_MODE, "fallback": SIZE_FALLBACK, "tooltip":
                    "The sizes follow the Setup mode. Speed: native (≈480p) up to 2K, upscaled. Hybrid: native "
                    "(≈540p) up to 4K, upscaled. Quality: native (≈768p), or 1080p/2K/4K after its polish "
                    "(and the upscaler for what the polish doesn't reach). "
                    "The short side lands exactly on the number (portrait too). 4K holds about 100 MB of RAM "
                    "per frame, so keep 4K clips short, especially at 48/60 fps."}),
                "final_fps": ("FLOAT", {"default": 24.0, "min": 24.0, "max": 120.0, "step": 1.0, "tooltip":
                    "24 = untouched. 48 / 60 = RIFE draws the in-between frames; length and sync kept."}),
                "upscaler": (UPSCALERS, {"default": "RTX VSR", "tooltip":
                    "Used when the final resolution needs an upscale. DLSS5 adds far more detail; Color Lock "
                    "then restores the original colours. Needs ComfyUI-DLSS5-Enhancer."}),
                "quality_polish_strength": ("FLOAT", {"default": 0.3, "min": 0.05, "max": 1.0, "step": 0.05,
                    "tooltip": "Quality mode at 1080p and up. 0.3 faithful, 0.45-0.55 cleaner but freer."}),
                "quality_polish_steps": ("INT", {"default": 12, "min": 1, "max": 100,
                    "tooltip": "Quality mode at 1080p and up."}),
                "quality_polish_method": (methods, {"default": methods[0], "tooltip":
                    "Quality mode only: how the polish enlarges the latent before re-sampling it. "
                    "learned model (2x) = the trained 2x upscaler; for a 1.5x polish zhangccccc's H3 "
                    "latent upscaler takes over and builds the 1.5x latent itself. learned model, any "
                    "scale = that upscaler at either scale. The others are plain interpolation."}),
            },
            # optional: a prompt or workflow saved without it still runs, with 1.5x
            "optional": {
                "quality_polish_scale": (list(POLISH_SCALES), {"default": "1.5x", "tooltip":
                    "Quality mode at 1080p and up: how much bigger than the take the polish renders. "
                    "1.5x (≈1152p from the Quality preset) covers 1080p and leaves 2K/4K to the "
                    "upscaler; about 3x faster per step than 2x, with room for longer chunks. It needs "
                    "zhangccccc's H3 latent upscaler (the Comfyui_Minimax_h3_latent_Upscaler nodes and "
                    "their model); without it the polish runs at 2x. 2x (≈1536p) for a take rendered "
                    "smaller, or to polish 2K itself; on a 32 GB card it fits chunks up to 8 s at the "
                    "Quality preset."}),
            }
        }

    RETURN_TYPES = ("H3_OUTPUT",)
    RETURN_NAMES = ("output",)
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self, mode, final_resolution, final_fps, upscaler, quality_polish_strength,
            quality_polish_steps, quality_polish_method, quality_polish_scale="1.5x"):
        mode = max(1, min(3, int(mode)))
        name = MODES[mode - 1]
        if final_resolution not in SIZES_BY_MODE[name]:
            size = SIZE_FALLBACK.get(name, {}).get(final_resolution, "1080p")
            log.warning("[StubeliusH3Output] %s doesn't offer %s; using %s", name, final_resolution, size)
            final_resolution = size
        o = dict(mode=mode, resolution=final_resolution, fps=float(final_fps), upscaler=upscaler,
                 polish_strength=quality_polish_strength, polish_steps=quality_polish_steps,
                 polish_method=_polish_methods().get(quality_polish_method, quality_polish_method),
                 polish_scale=POLISH_SCALES.get(quality_polish_scale, 1.5))
        log.info("[StubeliusH3Output] %s", o)
        return (o,)


# ---------------------------------------------------------------- Models

_BASE, _PATCHED, _AUX = {}, {}, {}


class H3Models:
    """Lazy model bundle. model(kind) loads + patches on first use; results are cached per config."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.key = tuple(sorted(cfg.items()))

    def _base(self, name):
        if name not in _BASE:
            log.info("[StubeliusH3Models] loading %s", name)
            if name.lower().endswith(".gguf"):
                if _cls("UnetLoaderGGUF") is None:
                    raise RuntimeError("[StubeliusH3Models] GGUF model selected but ComfyUI-GGUF is not installed")
                _BASE[name] = _run("UnetLoaderGGUF", unet_name=name)[0]
            else:
                _BASE[name] = _run("UNETLoader", unet_name=name, weight_dtype="default")[0]
        return _BASE[name]

    def model(self, kind):
        c = self.cfg
        name = c["ref2va_model"] if kind == "ref" else c["fl2va_model"]
        key = (kind, self.key)
        if key in _PATCHED:
            return _PATCHED[key]
        from .stubelius_v2 import _resolve_lora, _lora_state_dict
        m = self._base(name)
        loras = [(c["speedup_lora"], c["speedup_strength"])]
        loras += [(c["extra_lora_1"], c["extra_lora_1_strength"]), (c["extra_lora_2"], c["extra_lora_2_strength"])]
        for lname, strength in loras:
            if lname and lname != "none" and strength != 0:
                path = _resolve_lora(lname)
                if path is None:
                    raise FileNotFoundError(f"[StubeliusH3Models] LoRA '{lname}' not found in models/loras")
                m, _ = comfy.sd.load_lora_for_models(m, None, _lora_state_dict(path), strength, 0)
        if c["attention"] != "off":
            m = _patch(m, "ModelAttentionBackend", "attention backend", attention=c["attention"])
        if c["sage_attention"]:
            m = _patch(m, "MiniMaxH3MemoryEfficientSageAttentionPatch", "sage attention")
        if c["low_vram_attention"]:
            m = _patch(m, "MiniMaxLowVRAMAttention", "low VRAM attention", head_chunks=4)
        if c["chunk_feed_forward"]:
            m = _patch(m, "MiniMaxChunkFeedForward", "chunk feed-forward", chunks=2, seq_threshold=4096)
        if c["spectrum"]:
            m = _patch(m, "SpectrumApplyMiniMaxH3", "Spectrum", enabled=True, blend_weight=0.5, degree=1,
                       ridge_lambda=0.1, window_size=2.0, flex_window=0.75, warmup_steps=1,
                       tail_actual_steps=1, max_history=8, debug=False)
        if c["h3_cache"]:
            m = _patch(m, "H3MiniMaxCache", "H3 cache", reuse_threshold=0.11, start_percent=0.05,
                       end_percent=0.8, max_steps=1, device="auto", verbose=False)
        _PATCHED[key] = m
        return m

    def preview(self, model, node_id):
        """Attach the live sampling preview (KJ Model Preview Override) for the node that samples.
        Cheap (clone + wrapper), so it's applied per run instead of being cached."""
        tiny = self.cfg["live_preview"]
        cls = _cls("ModelPreviewOverrideKJ")
        if model is None or tiny == "off" or cls is None:
            return model
        saved = getattr(cls, "hidden", None)
        cls.hidden = types.SimpleNamespace(unique_id=node_id)   # normally set by ComfyUI's executor
        try:
            return _unpack_node_result(cls.execute(model=model, max_resolution=0, jpeg_quality=80,
                                                   suppress_default_preview=True, preview_frames=124,
                                                   preview_fps=24, vae=None, tiny_vae=tiny))[0]
        finally:
            cls.hidden = saved

    def clip(self):
        name = self.cfg["text_encoder"]
        if ("clip", name) not in _AUX:
            loader = "CLIPLoaderGGUF" if name.lower().endswith(".gguf") else "CLIPLoader"
            _AUX[("clip", name)] = _run(loader, clip_name=name, type="minimax")[0]
        return _AUX[("clip", name)]

    def _vae(self, name):
        if ("vae", name) not in _AUX:
            _AUX[("vae", name)] = _run("VAELoader", vae_name=name)[0]
        return _AUX[("vae", name)]

    def vae(self):
        return self._vae(self.cfg["video_vae"])

    def audio_vae(self):
        return self._vae(self.cfg["audio_vae"])


def _prune(cfg):
    """Drop cached models this config no longer references, so RAM follows the current setup."""
    names = {cfg["ref2va_model"], cfg["fl2va_model"]}
    for k in [k for k in _BASE if k not in names]:
        _BASE.pop(k)
    key = tuple(sorted(cfg.items()))
    for k in [k for k in _PATCHED if k[1] != key]:
        _PATCHED.pop(k)
    aux = {("clip", cfg["text_encoder"]), ("vae", cfg["video_vae"]), ("vae", cfg["audio_vae"])}
    for k in [k for k in _AUX if k not in aux]:
        _AUX.pop(k)


class StubeliusH3Models:
    @classmethod
    def INPUT_TYPES(cls):
        unets = folder_paths.get_filename_list("diffusion_models") + _gguf("unet_gguf")
        tes = folder_paths.get_filename_list("text_encoders") + _gguf("clip_gguf")
        vaes = folder_paths.get_filename_list("vae")
        loras = ["none"] + folder_paths.get_filename_list("loras")
        tiny = ["off"] + [v for v in folder_paths.get_filename_list("vae_approx")
                          if os.path.basename(v).lower().startswith("tae")]
        attention = ["off", "pytorch attention", "comfy kitchen attention"]
        return {
            "required": {
                "setup": ("H3_SETUP",),
                "ref2va_model": (unets, {"default": _first_match(unets, "ref2va_pruned_int8", "ref2va"),
                    "tooltip": "Reference (Omni) checkpoint. safetensors or GGUF."}),
                "fl2va_model": (unets, {"default": _first_match(unets, "fl2va_pruned_int8", "fl2va"),
                    "tooltip": "First/Last-Frame checkpoint, also used to Extend past one chunk. "
                               "Only loaded when needed."}),
                "text_encoder": (tes, {"default": _first_match(tes, "qwen3vl_32b_h3", "qwen3vl_32b_minimax", "minimax")}),
                "video_vae": (vaes, {"default": _first_match(vaes, "h3_video_vae")}),
                "audio_vae": (vaes, {"default": _first_match(vaes, "h3_audio_vae")}),
                "speedup_lora": (loras, {"default": _first_match(loras, "lightx2v_turbo_8step", "turbo"),
                    "tooltip": "Turbo/distill LoRA. Strength comes from the Setup mode (1.0 / 0.75 / 0.0)."}),
                "extra_lora_1": (loras, {"default": "none", "tooltip": "Applies to every chunk. "
                                          "Chunk-specific LoRAs go in the Director's chunk boxes."}),
                "extra_lora_1_strength": ("FLOAT", {"default": 1.0, "min": -2.0, "max": 2.0, "step": 0.05}),
                "extra_lora_2": (loras, {"default": "none"}),
                "extra_lora_2_strength": ("FLOAT", {"default": 1.0, "min": -2.0, "max": 2.0, "step": 0.05}),
                "attention": (attention, {"default": "comfy kitchen attention"}),
                "sage_attention": ("BOOLEAN", {"default": False}),
                "low_vram_attention": ("BOOLEAN", {"default": False, "tooltip": "Attention in head chunks (saves VRAM)."}),
                "chunk_feed_forward": ("BOOLEAN", {"default": False, "tooltip": "Feed-forward in chunks (saves VRAM)."}),
                "spectrum": ("BOOLEAN", {"default": False, "tooltip": "Spectrum step forecasting (faster, may soften)."}),
                "h3_cache": ("BOOLEAN", {"default": False, "tooltip": "PlagueKind H3 step cache (faster, may soften)."}),
                "live_preview": (tiny, {"default": _first_match(tiny, "taeh3_h3", "taeh3"),
                    "tooltip": "Tiny VAE (models/vae_approx) for the live preview on the Director while it "
                               "samples. off = ComfyUI's default preview."}),
            }
        }

    RETURN_TYPES = ("H3_MODELS",)
    RETURN_NAMES = ("models",)
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self, setup, **cfg):
        cfg["speedup_strength"] = float(setup["speedup_strength"])
        _prune(cfg)
        return (H3Models(cfg),)


# ---------------------------------------------------------------- Finish

def _short(images):
    return min(images.shape[1], images.shape[2])


def _target_size(images, short_side):
    """(width, height) with the short side at `short_side` and the shape kept, both multiples
    of 8 (what RTX VSR outputs; video encoders like it too)."""
    h, w = images.shape[1], images.shape[2]
    k = short_side / min(h, w)
    return max(8, round(w * k / 8) * 8), max(8, round(h * k / 8) * 8)


def _fit(images, short_side, inplace=False, batch=8):
    """Bring an IMAGE batch to _target_size; no-op when it already fits. A frame at most 2% too
    big (DLSS5 gives 1920x1088 for 1080p) is centre-cropped rather than resampled; otherwise
    bicubic, antialiased. inplace=True (a private tensor only, e.g. Finish's own DLSS5 output)
    writes a smaller result back into the same memory, so no second full-size copy is made:
    frame i lands at or before where frame i was, never over a frame not yet read."""
    n, h, w, c = images.shape
    width, height = _target_size(images, short_side)
    if (w, h) == (width, height):
        return images
    shrink = width <= w and height <= h
    crop = shrink and width >= 0.98 * w and height >= 0.98 * h
    y0, x0 = (h - height) // 2, (w - width) // 2
    size = height * width * c
    reuse = inplace and shrink and images.is_contiguous() and images.device.type == "cpu"
    if reuse:
        flat = images.view(-1)
    else:
        out = torch.empty((n, height, width, c), dtype=images.dtype)
    import comfy.model_management
    device = comfy.model_management.get_torch_device()
    for i in range(0, n, batch):
        if crop:
            part = images[i:i + batch, y0:y0 + height, x0:x0 + width].clone()
        else:
            x = images[i:i + batch].to(device).movedim(-1, 1)
            x = torch.nn.functional.interpolate(x, size=(height, width), mode="bicubic", antialias=True,
                                                align_corners=False)
            part = x.clamp(0, 1).movedim(1, -1).to("cpu", images.dtype).contiguous()
        if reuse:
            flat[i * size:(i + part.shape[0]) * size].copy_(part.view(-1))
        else:
            out[i:i + part.shape[0]] = part
    return flat[:n * size].view(n, height, width, c) if reuse else out


def _vsr(images, short_side):
    """RTX VSR to the exact size; past its 4x per pass (Speed to 4K) in two passes."""
    if short_side / _short(images) > VSR_MAX_SCALE:
        images = _vsr(images, max(8, round(short_side / 2 / 8) * 8))
    width, height = _target_size(images, short_side)
    return _run("RTXVideoSuperResolution", images=images,
                resize_type={"resize_type": "target dimensions", "width": width, "height": height},
                quality="ULTRA")[0]


def _dlss5(images, need):
    """One DLSS5 pass at the smallest factor that reaches `need` (its largest, 3x, when more is
    needed), so the exact fit afterwards is a slight downscale."""
    factor = next((f for f in DLSS5_FACTORS if f >= need - 0.005), max(DLSS5_FACTORS))
    settings = _run("DLSS5Settings", upscaling_mode=DLSS5_FACTORS[factor], nr_preset="Default",
                    nr_style="Default", nr_intensity=1.0, local_tone_strength=1.0,
                    local_structure_strength=1.5, skin_structure_strength=2.0, automatic_mask=True,
                    dlss_model_preset="M", motion="auto", scene_change_threshold=0.24, warmup_frames=0,
                    runtime_dir="")[0]
    return _run("DLSS5EnhanceImages", images=images, settings=settings, verify_neural_rendering=True)[0]


def _ram_check(images, target, fps):
    """The finished frames are held uncompressed (width x height x 12 bytes each). Say so up front
    when they alone won't fit in RAM, instead of letting the job crawl through the pagefile."""
    import psutil
    frames = round(images.shape[0] * max(1.0, fps / SOURCE_FPS))
    width, height = _target_size(images, target) if target else (images.shape[2], images.shape[1])
    need, total = frames * width * height * 12, psutil.virtual_memory().total
    if need > 0.6 * total:
        log.warning("[StubeliusH3Finish] %d frames at %dx%d need about %.0f GB of RAM on this %.0f GB "
                    "machine: expect a heavy slowdown. A shorter clip, a lower final FPS or a smaller "
                    "resolution avoids it.", frames, width, height, need / 1e9, total / 1e9)


_POLISH_MEMO = []   # [(key, (images, audio))], newest last, two kept


class StubeliusH3Finish:
    """The engine: everything it does comes from the Output node. WINNER is the only choice left
    after a seed hunt."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "takes": ("H3_TAKES",),
                "models": ("H3_MODELS",),
                "output": ("H3_OUTPUT",),
                "winner": ("INT", {"default": 1, "min": 0, "max": 4, "tooltip":
                    "Which seed to finish. 0 = hold: render the seeds and their previews only, then "
                    "set 1-4 and re-queue (the seeds come from cache, only the finish runs)."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT")
    RETURN_NAMES = ("images", "audio", "fps")
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self, takes, models, output, winner, unique_id=None):
        if int(winner) == 0:
            from comfy_execution.graph import ExecutionBlocker
            log.info("[StubeliusH3Finish] WINNER 0 = hold: %d seed(s) rendered, finish skipped. "
                     "Set WINNER 1-%d and re-queue.", takes["count"], takes["count"])
            return (ExecutionBlocker(None), ExecutionBlocker(None), ExecutionBlocker(None))
        w = max(1, min(int(winner), takes["count"]))
        if w != winner:
            log.warning("[StubeliusH3Finish] WINNER %d but only %d seed(s) rendered, using %d",
                        winner, takes["count"], w)
        o = output
        target = RESOLUTIONS.get(o["resolution"])
        images, audio = takes["images"][w - 1], takes["audio"][w - 1]
        if o["mode"] == 3 and target and target > POLISH_ABOVE * _short(images):
            # Quality re-renders the take 1.5x or 2x bigger (the polish) when the size picked is
            # above what it rendered; at or below that, the render itself is the final picture.
            # The upscaler takes it the rest of the way. A take past one chunk is polished chunk
            # by chunk. Either way only the picture is rendered again, so the take keeps its own sound.
            from .muse_minimax_refine import effective_polish_scale
            from .stubelius_polish import chunks_of
            polish = self._polish_chunks if len(chunks_of(takes["latents"][w - 1])) > 1 else self._polish
            scale = effective_polish_scale(o["polish_method"], o.get("polish_scale", 2.0), "[StubeliusH3Finish]")
            images = polish(takes, models, w, o["polish_strength"], o["polish_steps"],
                            o["polish_method"], unique_id, scale=scale)[0]
        _ram_check(images, target, o["fps"])
        if target and _short(images) > target:
            # e.g. Quality 2K: the polish comes out above 1440p. Downscale before RIFE (less work).
            images = _fit(images, target)

        fps = SOURCE_FPS
        if o["fps"] > SOURCE_FPS + 1e-6:
            from .stubelius_rife_fps import StubeliusRIFEToFPS
            images, fps = StubeliusRIFEToFPS().run(images, SOURCE_FPS, o["fps"], "rife47.pth", True, True, 8)

        upscaled = bool(target and target / _short(images) > 1.02)
        if upscaled:
            images = self._upscale(images, target, o["upscaler"])
        if target:
            images = _fit(images, target)   # exact size (DLSS5 only scales 1.5x / 2x)
        log.info("[StubeliusH3Finish] mode %d, winner %d, %s -> %dx%d @ %.3g fps, upscaler %s",
                 o["mode"], w, o["resolution"], images.shape[2], images.shape[1], fps,
                 o["upscaler"] if upscaled else "none")
        return (images, audio, float(fps))

    @staticmethod
    def _polish(takes, models, w, strength, steps, method, node_id=None, scale=2.0):
        key = (id(takes), w, strength, steps, method, models.key, scale)
        for k, v in _POLISH_MEMO:
            if k == key:
                log.info("[StubeliusH3Finish] Quality polish reused from memory (winner %d)", w)
                return v
        from .stubelius_v2 import StubeliusH3RefineV2
        lat = takes["latents"]
        images, audio = _unpack_node_result(StubeliusH3RefineV2().execute_v2(
            model=models.preview(models.model(takes["kind"]), node_id), clip=models.clip(), vae=models.vae(),
            audio_vae=models.audio_vae(), prompt=takes["prompt"], candidate=w,
            upscale_method=method, polish_strength=strength, polish_steps=steps,
            candidate_1_latent=lat[0], candidate_2_latent=lat[1], candidate_3_latent=lat[2],
            candidate_4_latent=lat[3], ref_images=takes["ref_images"], polish_scale=scale))[:2]
        _POLISH_MEMO.append((key, (images, audio)))
        del _POLISH_MEMO[:-2]
        return images, audio

    @staticmethod
    def _polish_chunks(takes, models, w, strength, steps, method, node_id=None, scale=2.0):
        """The polish of a take that runs past one chunk: every chunk of it (stubelius_polish.py),
        where _polish would hand the Refine the last chunk alone."""
        import psutil
        from .stubelius_polish import polish
        candidate, take = takes["latents"][w - 1], takes["images"][w - 1]
        made = candidate.get("_muse_stage1_settings") or {}
        # by what the take is, not only by id(takes): a new take can get a freed one's id
        key = (id(takes), w, strength, steps, method, models.key, scale, tuple(take.shape),
               made.get("seed"), made.get("steps"), hash(made.get("compiled_prompt")))
        for k, v in _POLISH_MEMO:
            if k == key:
                log.info("[StubeliusH3Finish] Quality polish reused from memory (winner %d)", w)
                return v
        images = polish(candidate, models, strength, steps, method, frames=take.shape[0], node_id=node_id,
                        scale=scale)
        _POLISH_MEMO.append((key, (images, takes["audio"][w - 1])))
        del _POLISH_MEMO[:-2]
        # two polished long takes are tens of GB: keep the older one only while both fit easily
        held = sum(v[0].numel() * v[0].element_size() for _, v in _POLISH_MEMO if torch.is_tensor(v[0]))
        if len(_POLISH_MEMO) > 1 and held > 0.35 * psutil.virtual_memory().total:
            del _POLISH_MEMO[0]
        return images, takes["audio"][w - 1]

    @staticmethod
    def _upscale(images, short_side, upscaler):
        if upscaler == "RTX VSR":
            return _vsr(images, short_side)
        if _cls("DLSS5EnhanceImages") is None:
            raise RuntimeError("[StubeliusH3Finish] 'DLSS5 + Color Lock' needs ComfyUI-DLSS5-Enhancer installed. "
                               "Pick 'RTX VSR' or install it.")
        enhanced = _dlss5(images, short_side / _short(images))
        rest = short_side / _short(enhanced)
        if rest > 1.02:
            # past DLSS5's 3x (Speed/Hybrid to 4K): RTX VSR takes it the rest of the way, or a
            # second DLSS5 pass when VSR isn't installed
            enhanced = _vsr(enhanced, short_side) if _cls("RTXVideoSuperResolution") else _dlss5(enhanced, rest)
        from .stubelius_color_lock import StubeliusColorLock
        # The upscaled frames are ours alone (unless DLSS5 handed back its input): Color Lock and
        # the exact fit then work in place, so the frames exist once, not three times.
        private = enhanced.untyped_storage().data_ptr() != images.untyped_storage().data_ptr()
        enhanced = StubeliusColorLock().run(enhanced, images, 1.0, 16, inplace=private)[0]
        return _fit(enhanced, short_side, inplace=private)


THEMES = ["Studio slate", "Stuubzzz neon", "Film stock", "Paper light", "Midnight blueprint", "ComfyUI default"]


class StubeliusTheme:
    """Look of THIS workflow only (js/stubelius_theme.js). Saved in the workflow; never runs."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"theme": (THEMES, {"default": "Studio slate", "tooltip":
            "Applies to this workflow only, while its tab is open. Other workflows keep their look."})}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self, theme):
        return ()


class StubeliusLivePreview:
    """Display-only panel for the live sampling preview (see js/stubelius_live_preview.js).
    No inputs or outputs; it never runs as part of the prompt."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self):
        return ()


NODE_CLASS_MAPPINGS = {
    "StubeliusTheme": StubeliusTheme,
    "StubeliusLivePreview": StubeliusLivePreview,
    "StubeliusH3Setup": StubeliusH3Setup,
    "StubeliusH3Output": StubeliusH3Output,
    "StubeliusH3Models": StubeliusH3Models,
    "StubeliusH3Finish": StubeliusH3Finish,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "StubeliusTheme": "Stubelius Theme (this workflow)",
    "StubeliusLivePreview": "Stubelius Live Preview",
    "StubeliusH3Setup": "Stubelius H3 Setup",
    "StubeliusH3Output": "Stubelius H3 Output",
    "StubeliusH3Models": "Stubelius H3 Models",
    "StubeliusH3Finish": "Stubelius H3 Finish",
}
