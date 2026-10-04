"""Stubelius H3 Director V2 / Refine V2 — content-only front ends over the V1.2 engines.

The Director keeps only what the video IS (input mode, timeline, aspect, duration, seed).
How it gets made — resolution, steps, sampler, scheduler, how many seeds — arrives on
sockets from the workflow's setup stage, with standalone defaults when unwired.
Two-stage sampling and latent scouting are gone; the VAE re-encode carry (extend
continuity, only acts on 2+ chunks) is on whenever its helper pack is installed. The main
images/audio output is always candidate 1 (V1.2 blocks it during a hunt).
"""
import json
import logging
import os
import re

import comfy.samplers
import comfy.sd
import comfy.utils
import folder_paths

from .muse_minimax_director import MuseMinimaxDirector, MODE_REFERENCE
from .muse_minimax_refine import MuseMinimaxRefine
from .stubelius_compiler import compiler_paused
from .stubelius_lora_convert import convert as convert_diffusers_h3, is_diffusers_h3

log = logging.getLogger(__name__)

# Turbo/distill LoRAs are paired with MODE's global steps/sampler, so they belong in the
# main chain, never on a single chunk.
TURBO_LORA_PATTERN = re.compile(r"turbo|lightx2v|taomate|fasth3|distill|lightning|step|pdmd|nfe", re.I)
_LORA_SD_CACHE = {}   # (path, mtime) -> state dict, so each file loads once per session


def _resolve_lora(name):
    for candidate in (name, name.replace("\\", "/"), name.replace("/", "\\")):
        path = folder_paths.get_full_path("loras", candidate)
        if path:
            return path
    return None


def _lora_state_dict(path):
    key = (path, os.path.getmtime(path))
    if key not in _LORA_SD_CACHE:
        sd, metadata = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
        if is_diffusers_h3(sd):            # e.g. PDMD's LoRA as published: rewrite it for ComfyUI's H3
            sd = convert_diffusers_h3(sd, metadata)
        _LORA_SD_CACHE[key] = sd
    return _LORA_SD_CACHE[key]


def _build_lora_plan(timeline_data):
    """{chunk_idx: [(name, path, strength), ...]} from timeline_data.chunks[i].loras.
    Raises before any sampling if a named file is missing."""
    try:
        tdata = json.loads(timeline_data or "{}")
    except (TypeError, ValueError):
        return {}
    plan, missing = {}, []
    for idx, chunk in enumerate(tdata.get("chunks") or []):
        rows = []
        for row in (chunk or {}).get("loras") or []:
            name = (row or {}).get("name") or ""
            strength = float((row or {}).get("strength", 1.0) or 0.0)
            if not name or not row.get("enabled", True) or strength == 0.0:
                continue
            path = _resolve_lora(name)
            if path is None:
                missing.append(f"chunk {idx + 1}: LoRA '{name}' not found in models/loras")
                continue
            if TURBO_LORA_PATTERN.search(name):
                log.warning("[StubeliusH3DirectorV2] chunk %d: '%s' looks like a turbo LoRA — "
                            "turbo LoRAs belong in the main chain; steps are global.", idx + 1, name)
            rows.append((name, path, strength))
        if rows:
            plan[idx] = rows
    if missing:
        raise FileNotFoundError("[StubeliusH3DirectorV2] " + "; ".join(missing))
    return plan

_DIRECTOR_KEEP_REQUIRED = ("mode", "aspect_ratio", "duration_seconds", "chunk_duration_seconds",
                           "seed", "timeline_data")


class StubeliusH3DirectorV2(MuseMinimaxDirector):
    @classmethod
    def INPUT_TYPES(cls):
        base = MuseMinimaxDirector.INPUT_TYPES()
        required = {k: base["required"][k] for k in _DIRECTOR_KEEP_REQUIRED}
        optional = {
            "models": ("H3_MODELS", {"tooltip": "From Stubelius H3 Models. Replaces model/clip/vae sockets."}),
            "setup": ("H3_SETUP", {"tooltip": "From Stubelius H3 Setup. Replaces the size/steps/sampler/seed sockets."}),
            "model": base["required"]["model"], "clip": base["required"]["clip"],
            "vae": base["required"]["vae"], "audio_vae": base["required"]["audio_vae"],
            "model_fl2va": base["optional"]["model_fl2va"],
            "prompt_override": ("STRING", {"forceInput": True, "tooltip":
                "Fully formatted H3 prompt. Used instead of the timeline whenever it contains text."}),
            "megapixels": ("FLOAT", {"forceInput": True, "default": 0.98, "min": 0.1, "max": 4.0,
                "tooltip": "Render size. Set by the workflow's MODE; 0.98 when unwired."}),
            "steps": ("INT", {"forceInput": True, "default": 8, "min": 1, "max": 100}),
            "sampler_name": ("STRING", {"forceInput": True, "default": "euler"}),
            "scheduler": ("STRING", {"forceInput": True, "default": "beta"}),
            "seed_count": ("INT", {"forceInput": True, "default": 1, "min": 1, "max": 4,
                "tooltip": "How many full videos to render (seed, seed+1000003, ...). "
                           "All come out on candidate_1..4; images/audio is always candidate 1."}),
        }
        return {"required": required, "optional": optional, "hidden": {"unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = MuseMinimaxDirector.RETURN_TYPES + ("H3_TAKES",)
    RETURN_NAMES = MuseMinimaxDirector.RETURN_NAMES + ("takes",)
    FUNCTION = "execute_v2"
    CATEGORY = "Stubelius"

    @compiler_paused
    def execute_v2(self, mode, aspect_ratio, duration_seconds, chunk_duration_seconds, seed, timeline_data,
                   models=None, setup=None, model=None, clip=None, vae=None, audio_vae=None,
                   model_fl2va=None, prompt_override=None,
                   megapixels=0.98, steps=8, sampler_name="euler", scheduler="beta", seed_count=1,
                   unique_id=None):
        if setup is not None:
            megapixels, steps = setup["megapixels"], setup["steps"]
            sampler_name, scheduler, seed_count = setup["sampler"], setup["scheduler"], setup["seed_count"]
        if models is not None:
            clip, vae, audio_vae = models.clip(), models.vae(), models.audio_vae()
            if mode == MODE_REFERENCE:
                model = models.model("ref")
                model_fl2va = models.model("fl2va") if duration_seconds > chunk_duration_seconds else None
            else:
                model, model_fl2va = None, models.model("fl2va")
            model, model_fl2va = models.preview(model, unique_id), models.preview(model_fl2va, unique_id)
        if (model is None and model_fl2va is None) or clip is None or vae is None or audio_vae is None:
            raise ValueError("[StubeliusH3DirectorV2] connect 'models' (Stubelius H3 Models) "
                             "or the model/clip/vae/audio_vae sockets")
        if sampler_name not in comfy.samplers.KSampler.SAMPLERS:
            raise ValueError(f"[StubeliusH3DirectorV2] unknown sampler '{sampler_name}'")
        if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
            raise ValueError(f"[StubeliusH3DirectorV2] unknown scheduler '{scheduler}'")
        n = max(1, min(4, int(seed_count)))
        use_override = bool(prompt_override and str(prompt_override).strip())
        hybrid = (model_fl2va is not None and mode == MODE_REFERENCE
                  and duration_seconds > chunk_duration_seconds)
        upscale_methods = MuseMinimaxDirector.INPUT_TYPES()["required"]["two_stage_upscale_method"][0]
        from nodes import NODE_CLASS_MAPPINGS
        carry = ("MiniMaxH3GeneratedAVMaskedContext" in NODE_CLASS_MAPPINGS
                 and "VAEEncodeAudio" in NODE_CLASS_MAPPINGS)

        self._lora_plan = _build_lora_plan(timeline_data)
        self._lora_models = {}
        try:
            out = self._execute_v1(mode, model, clip, vae, audio_vae, aspect_ratio, megapixels,
                                   duration_seconds, chunk_duration_seconds, hybrid, carry, seed,
                                   use_override, steps, sampler_name, scheduler, upscale_methods,
                                   timeline_data, n, model_fl2va, prompt_override)
        finally:
            self._lora_plan, self._lora_models = {}, {}
        out[0], out[1] = out[4], out[5]
        takes = {
            "count": n, "prompt": out[2], "ref_images": out[3],
            "images": [out[4], out[6], out[8], out[10]], "audio": [out[5], out[7], out[9], out[11]],
            "latents": [out[12], out[13], out[14], out[15]],
            "kind": "ref" if (mode == MODE_REFERENCE and model is not None) else "fl2va",
        }
        return tuple(out) + (takes,)

    def _execute_v1(self, mode, model, clip, vae, audio_vae, aspect_ratio, megapixels,
                    duration_seconds, chunk_duration_seconds, hybrid, carry, seed, use_override,
                    steps, sampler_name, scheduler, upscale_methods, timeline_data, n,
                    model_fl2va, prompt_override):
        return list(self.execute(
            mode=mode, model=model, clip=clip, vae=vae, audio_vae=audio_vae,
            aspect_ratio=aspect_ratio, megapixels=megapixels, multiple=32, resize_method="crop",
            duration_seconds=duration_seconds, chunk_duration_seconds=chunk_duration_seconds,
            ref_image_size="match", hybrid_continuation=hybrid, seam_interpolation_frames=2,
            vae_reencode_carry_test=carry, vae_reencode_carry_length=39,
            seed=seed, seed_hunt=False, use_prompt_override=use_override,
            steps=steps, sampler_name=sampler_name, scheduler=scheduler,
            two_stage_sampling=False, two_stage_first_pass_steps=2, two_stage_upscale_factor=1.5,
            two_stage_upscale_method=upscale_methods[0], two_stage_seed_hunt_latent_only=False,
            shift_video=12.0, shift_audio=3.0, timeline_data=timeline_data,
            candidate_2=n >= 2, candidate_3=n >= 3, candidate_4=n >= 4,
            model_fl2va=model_fl2va, prompt_override=prompt_override,
        ))

    def _chunk_model(self, chunk_idx, model):
        rows = getattr(self, "_lora_plan", {}).get(chunk_idx)
        if not rows:
            log.info("[StubeliusH3DirectorV2] chunk %d: LoRAs = none (global chain only)", chunk_idx + 1)
            return model
        key = (chunk_idx, id(model))
        if key not in self._lora_models:
            patched = model
            for _, path, strength in rows:
                patched, _ = comfy.sd.load_lora_for_models(patched, None, _lora_state_dict(path), strength, 0)
            self._lora_models[key] = patched
            log.info("[StubeliusH3DirectorV2] chunk %d: LoRAs = %s (sum %.2f)", chunk_idx + 1,
                     ", ".join(f"{os.path.basename(n)}@{s:.2f}" for n, _, s in rows),
                     sum(abs(s) for _, _, s in rows))
        return self._lora_models[key]

    def _chunk_loras(self, chunk_idx):
        return list(getattr(self, "_lora_plan", {}).get(chunk_idx) or [])


class StubeliusH3RefineV2(MuseMinimaxRefine):
    @classmethod
    def INPUT_TYPES(cls):
        base = MuseMinimaxRefine.INPUT_TYPES()
        req = base["required"]
        return {
            "required": {
                "model": req["model"], "clip": req["clip"], "vae": req["vae"], "audio_vae": req["audio_vae"],
                "prompt": ("STRING", {"forceInput": True,
                    "tooltip": "The Director's compiled_prompt."}),
                "candidate": ("INT", {"forceInput": True, "default": 1, "min": 1, "max": 4,
                    "tooltip": "Which candidate to polish (the workflow's WINNER)."}),
                "upscale_method": (req["two_stage_upscale_method"][0],
                    {"default": req["two_stage_upscale_method"][0][0]}),
                "polish_strength": ("FLOAT", {"default": 0.3, "min": 0.05, "max": 1.0, "step": 0.05,
                    "tooltip": "How much of the take gets re-rendered at the higher resolution. "
                               "0.3 stays faithful; 0.45-0.55 is cleaner but freer."}),
                "polish_steps": ("INT", {"default": 12, "min": 1, "max": 100}),
            },
            "optional": {
                **{k: base["optional"][k] for k in
                   ("candidate_1_latent", "candidate_2_latent", "candidate_3_latent",
                    "candidate_4_latent", "ref_images")},
                "polish_scale": ("FLOAT", {"default": 2.0, "min": 1.25, "max": 2.0, "step": 0.25, "tooltip":
                    "How much bigger than the take the polish renders. 1.5 is about 3x faster per step "
                    "than 2 and leaves the rest of the way to an upscaler; with the learned method it "
                    "needs zhangccccc's H3 latent upscaler, without which 2 is used."}),
            },
        }

    FUNCTION = "execute_v2"
    CATEGORY = "Stubelius"

    @compiler_paused
    def execute_v2(self, model, clip, vae, audio_vae, prompt, candidate, upscale_method,
                   polish_strength, polish_steps, candidate_1_latent=None, candidate_2_latent=None,
                   candidate_3_latent=None, candidate_4_latent=None, ref_images=None, polish_scale=2.0):
        from .stubelius_polish import chunks_of, polish_tokens, save_vram
        picked = (candidate_1_latent, candidate_2_latent, candidate_3_latent,
                  candidate_4_latent)[max(1, min(4, int(candidate))) - 1]
        if len(chunks_of(picked)) > 1:
            # this node would polish the take's last chunk and return that as the whole video
            raise RuntimeError(
                f"[StubeliusH3RefineV2] this take has {len(chunks_of(picked))} chunks. Each chunk is polished with "
                "the checkpoint that made it and this node has one model input: send the take to "
                "Stubelius H3 Finish in Quality mode, which polishes all of them.")
        from .muse_minimax_refine import effective_polish_scale
        scale = effective_polish_scale(upscale_method, polish_scale if polish_scale is not None else 2.0,
                                       "[StubeliusH3RefineV2]")
        if isinstance(picked, dict) and "samples" in picked:
            # a 10 s take polished for 2K doesn't fit a 32 GB card without them
            model = save_vram(model, polish_tokens(picked, scale))
        return self.execute(
            model=model, clip=clip, vae=vae, audio_vae=audio_vae, prompt=prompt,
            candidate=max(1, min(4, int(candidate))), ref_image_size="match",
            seed=0, steps=8, two_stage_first_pass_steps=2, sampler_name="euler", scheduler="beta",
            two_stage_upscale_factor=scale, two_stage_upscale_method=upscale_method,
            sync_from_director=True, audio_mode="keep candidate audio (locked)",
            refine_denoise=polish_strength, polish_steps=polish_steps,
            two_stage_strategy="complete then polish (stubelius)",
            candidate_1_latent=candidate_1_latent, candidate_2_latent=candidate_2_latent,
            candidate_3_latent=candidate_3_latent, candidate_4_latent=candidate_4_latent,
            ref_images=ref_images,
        )


NODE_CLASS_MAPPINGS = {
    "StubeliusH3DirectorV2": StubeliusH3DirectorV2,
    "StubeliusH3RefineV2": StubeliusH3RefineV2,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "StubeliusH3DirectorV2": "Stubelius H3 Director V2",
    "StubeliusH3RefineV2": "Stubelius H3 Refine V2",
}
