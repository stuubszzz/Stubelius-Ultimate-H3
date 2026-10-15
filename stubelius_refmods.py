"""RefMods in the Director: saved H3 references (ComfyUI-MiniMaxH3Mod's file format, MIT, (c) 2026 Luisa
(luisacaotica)) attached to every chunk's conditioning, the way that pack's Apply H3 RefMod node does it:
appended to `minimax_refs`, the list core's MiniMaxH3ReferenceToVideo fills, so they ride H3's native reference
path in Reference and in First/Last Frame mode.

A RefMod is a VAE latent [1, 24, T, H, W] (one picture: T = 1; stacked photos or a clip: T > 1) with JSON metadata
in the safetensors header. Strength below 1 mixes the latent towards a blurred copy of itself (the pack's maths,
`core._blur_latent` / `H3RefMod.ref_block`), so a weaker reference stays a plausible one.

timeline_data["refmods"] = [{"file": "<name or path>", "strength": 1.0}, ...]
"""
import json
import logging
import os

import torch
import torch.nn.functional as F

log = logging.getLogger(__name__)
FOLDER = "refmods"


def roots():
    out = []
    env = os.environ.get("STUBELIUS_REFMODS_DIR")
    if env:
        out.append(env)
    try:
        import folder_paths
        if FOLDER in folder_paths.folder_names_and_paths:
            out += list(folder_paths.folder_names_and_paths[FOLDER][0])
        else:
            for base in folder_paths.folder_names_and_paths.get("loras", ([], set()))[0]:
                out.append(os.path.join(os.path.dirname(base.rstrip("\\/")), FOLDER))
            out.append(os.path.join(folder_paths.models_dir, FOLDER))
    except Exception:
        pass
    seen, uniq = set(), []
    for r in out:
        k = os.path.normcase(os.path.abspath(r))
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    return uniq


def find(name):
    """A RefMod's file: an absolute path, or a name (with or without .safetensors, subfolders with /) in a refmods
    folder."""
    if not name:
        return None
    name = str(name)
    if os.path.isabs(name) and os.path.isfile(name):
        return name
    rel = name if name.lower().endswith(".safetensors") else name + ".safetensors"
    for r in roots():
        p = os.path.join(r, *rel.replace("\\", "/").split("/"))
        if os.path.isfile(p):
            return p
    return None


def read(path):
    """Every visual reference in a RefMod file: [(latent [1,24,T,H,W] float, meta), ...].
    Standalone (format 4): tensor `latent`, JSON under the header key `refmod_meta`. Bundle (format 5):
    `refmod_meta` = {"kind": "bundle", "members": [...]}, member i's tensor is `ref_i` (the pack's BUNDLE_FORMAT.md)."""
    from safetensors import safe_open
    out = []
    with safe_open(path, framework="pt", device="cpu") as f:
        try:
            meta = json.loads((f.metadata() or {}).get("refmod_meta", "{}"))
        except ValueError:
            meta = {}
        keys = set(f.keys())
        if meta.get("kind") == "bundle":
            for i, mem in enumerate(meta.get("members") or []):
                if isinstance(mem, dict) and mem.get("kind") in ("image", "video") and f"ref_{i}" in keys:
                    out.append((f.get_tensor(f"ref_{i}").float(), mem))
        elif meta.get("kind") in ("image", "video") and "latent" in keys:
            out.append((f.get_tensor("latent").float(), meta))
    return out


def _blur(z, factor=8):
    t, h, w = z.shape[2], z.shape[3], z.shape[4]
    down = F.adaptive_avg_pool3d(z.float(), (t, max(1, h // factor), max(1, w // factor)))
    return F.interpolate(down, size=(t, h, w), mode="trilinear", align_corners=False).to(z.dtype)


def blocks(entries):
    """The ref blocks for timeline_data["refmods"], strength applied; files that can't be read are skipped."""
    out = []
    for e in entries or []:
        if not isinstance(e, dict) or e.get("enabled") is False:
            continue
        strength = max(0.0, min(1.0, float(e.get("strength", 1.0))))
        path = find(e.get("file"))
        if path is None or strength <= 0:
            if path is None:
                log.warning("[StubeliusRefMods] no RefMod file '%s'", e.get("file"))
            continue
        for latent, m in read(path):
            if latent.dim() != 5:
                continue
            if strength < 1.0:
                latent = strength * latent + (1.0 - strength) * _blur(latent)
            t, h, w = latent.shape[2], latent.shape[3], latent.shape[4]
            block = {"kind": "video" if t > 1 else "image", "latent_h": int(h), "latent_w": int(w), "latent": latent}
            if t > 1:
                block.update(latent_t=int(t), ref_audio_t=0, audio_latent=None)
            out.append(block)
            log.info("[StubeliusRefMods] %s: %d picture(s) %dx%d latent, %d tokens, strength %.2f",
                     os.path.basename(path), t, h, w, t * (h // 2) * (w // 2), strength)
    return out


def attach(conditioning, refs):
    """Append the blocks to every entry's minimax_refs, as Apply H3 RefMod does."""
    if not refs:
        return conditioning
    out = []
    for t in conditioning:
        d = dict(t[1])
        d["minimax_refs"] = list(d.get("minimax_refs", [])) + list(refs)
        out.append([t[0], d])
    return out


def stamp(entries):
    """What the takes key needs: each file's identity (path, size, time) and strength."""
    rows = []
    for e in entries or []:
        if not isinstance(e, dict) or e.get("enabled") is False:
            continue
        path = find(e.get("file"))
        st = os.stat(path) if path else None
        rows.append([str(e.get("file")), float(e.get("strength", 1.0)),
                     [st.st_size, int(st.st_mtime)] if st else None])
    return rows
