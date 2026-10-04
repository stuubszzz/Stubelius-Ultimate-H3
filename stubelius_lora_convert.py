"""MiniMax H3 LoRAs saved with Diffusers module names (PEFT), made loadable by ComfyUI.

ComfyUI's H3 model has one fused q/k/v projection and keeps the SwiGLU halves as [gate; value], while
Diffusers' MiniMaxH3Transformer3DModel has separate to_q/to_k/to_v and [value; gate]. ComfyUI's LoRA key map
only knows its own names, so such a LoRA (PDMD's, for one) would load with every key skipped and change
nothing. This rewrites it once, in memory, into the layout ComfyUI applies:

- transformer_blocks.N -> blocks.N, token_refiner.refiner_blocks.N -> token_refiner.blocks.N
- attn.to_q / to_k / to_v -> attn.qkv_proj: A = [A_q; A_k; A_v], B = blockdiag(B_q, B_k, B_v), and alpha x3
  because the fused rank is 3r (ComfyUI scales by alpha / rank)
- attn.to_out.0 -> attn.out_proj
- ff.net.0.proj -> mlp.fc1 with B's two halves swapped ([value; gate] -> [gate; value])
- ff.net.2 -> mlp.fc2

PEFT files keep alpha in the metadata (lora_alpha) rather than as tensors; without it alpha = rank (scale 1).
"""
import logging
import re

import torch

log = logging.getLogger(__name__)

_KEY = re.compile(r"^(?:transformer\.|diffusion_model\.|base_model\.model\.)?"
                  r"((?:transformer_blocks|token_refiner\.refiner_blocks)\.\d+\..+)\.lora_([AB])\.weight$")


def is_diffusers_h3(sd):
    """True for an H3 LoRA in Diffusers naming (a to_q LoRA on a transformer or refiner block)."""
    return any(_KEY.match(k) and ".attn.to_q.lora_A." in k for k in sd)


def _comfy_block(module):
    module = re.sub(r"^transformer_blocks\.(\d+)\.", r"blocks.\1.", module)
    return re.sub(r"^token_refiner\.refiner_blocks\.(\d+)\.", r"token_refiner.blocks.\1.", module)


def convert(sd, metadata=None):
    """Diffusers H3 LoRA state dict -> ComfyUI H3 LoRA state dict (diffusion_model.* keys)."""
    metadata = metadata or {}
    pairs, other = {}, []
    for k, v in sd.items():
        m = _KEY.match(k)
        if m:
            pairs.setdefault(m.group(1), {})[m.group(2)] = v
        elif not k.endswith(".alpha"):
            other.append(k)
    some = next(iter(pairs.values()))
    rank = int(metadata.get("lora_rank") or some["A"].shape[0])
    alpha = float(metadata.get("lora_alpha") or rank)

    out, done, skipped = {}, set(), []

    def put(name, a, b, alpha_value):
        out[f"diffusion_model.{name}.lora_A.weight"] = a.contiguous()
        out[f"diffusion_model.{name}.lora_B.weight"] = b.contiguous()
        out[f"diffusion_model.{name}.alpha"] = torch.tensor(alpha_value)

    for module in sorted(pairs):
        if module in done:
            continue
        p = pairs[module]
        if "A" not in p or "B" not in p:
            skipped.append(module)
            continue
        if module.endswith(".attn.to_q"):
            stem = module[:-len("to_q")]
            parts = [pairs.get(stem + s) for s in ("to_q", "to_k", "to_v")]
            if any(x is None or "A" not in x or "B" not in x for x in parts):
                skipped.append(stem + "to_q/k/v")
                done.update(stem + s for s in ("to_q", "to_k", "to_v"))
                continue
            put(_comfy_block(stem) + "qkv_proj", torch.cat([x["A"] for x in parts], dim=0),
                torch.block_diag(*[x["B"] for x in parts]), alpha * 3)
            done.update(stem + s for s in ("to_q", "to_k", "to_v"))
        elif module.endswith((".attn.to_k", ".attn.to_v")):
            continue                                   # fused with to_q
        elif module.endswith(".attn.to_out.0"):
            put(_comfy_block(module).replace(".attn.to_out.0", ".attn.out_proj"), p["A"], p["B"], alpha)
            done.add(module)
        elif module.endswith(".ff.net.0.proj"):
            value, gate = p["B"].chunk(2, dim=0)
            put(_comfy_block(module).replace(".ff.net.0.proj", ".mlp.fc1"), p["A"], torch.cat([gate, value]), alpha)
            done.add(module)
        elif module.endswith(".ff.net.2"):
            put(_comfy_block(module).replace(".ff.net.2", ".mlp.fc2"), p["A"], p["B"], alpha)
            done.add(module)
        else:
            skipped.append(module)
    skipped += [m for m in pairs if m not in done and m not in skipped
                and not m.endswith((".attn.to_k", ".attn.to_v"))]
    if skipped or other:
        log.warning("[Stubelius] H3 LoRA in Diffusers naming: %d module(s) without a ComfyUI mapping were left "
                    "out (%s)", len(skipped) + len(other), ", ".join((skipped + other)[:4]))
    log.info("[Stubelius] H3 LoRA in Diffusers naming converted for ComfyUI: %d modules, rank %d, alpha %g",
             len(done), rank, alpha)
    return out
