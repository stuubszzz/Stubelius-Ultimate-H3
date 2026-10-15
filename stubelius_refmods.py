"""Characters saved from many pictures (RefMods) for the Director.

A RefMod is a set of pictures of one character, encoded once with H3's video VAE and stacked as one reference
[1, 24, T, H, W] (T = the number of pictures), saved as .safetensors with JSON metadata under the header key
`refmod_meta`. The file format is ComfyUI-MiniMaxH3Mod's (MIT, (c) 2026 Luisa (luisacaotica)); files made by that
pack, by Fizgig (its tuned mods) and by this one are interchangeable. Bundles (format 5: `ref_i` tensors) load too.

On every chunk the Director appends them to the conditioning's `minimax_refs`, the list core's
MiniMaxH3ReferenceToVideo fills, as that pack's Apply node does: they ride H3's native reference path in Reference
and in First/Last Frame mode. The text encoder never sees them, so the shots describe the character in words (each
RefMod keeps its description for that). Strength below 1 mixes the latent towards a blurred copy of itself (the
pack's maths), so a weaker reference stays a plausible one. Each picture costs about 1,000 reference tokens at 1 MP
and 500 at 0.5 MP, in every sampling step.

timeline_data["refmods"] = [{"file": "<name in a refmods folder, or a path>", "strength": 1.0}, ...]
"""
import json
import logging
import os
import re
import tempfile
import time

import numpy as np
import torch
import torch.nn.functional as F

import folder_paths

log = logging.getLogger(__name__)
FOLDER = "refmods"
META_KEY = "refmod_meta"
MAX_PICTURES = 24


def _register():
    """A `refmods` model folder next to the other models (the default extra path's, else ComfyUI's own), unless
    ComfyUI-MiniMaxH3Mod already registered one."""
    if FOLDER in folder_paths.folder_names_and_paths:
        return
    paths = []
    for base in folder_paths.folder_names_and_paths.get("loras", ([], set()))[0]:
        paths.append(os.path.join(os.path.dirname(base.rstrip("\\/")), FOLDER))
    paths.append(os.path.join(folder_paths.models_dir, FOLDER))
    uniq = []
    for p in paths:
        if os.path.normcase(os.path.abspath(p)) not in [os.path.normcase(os.path.abspath(u)) for u in uniq]:
            uniq.append(p)
    folder_paths.folder_names_and_paths[FOLDER] = (uniq, {".safetensors"})


_register()


def roots():
    out = []
    env = os.environ.get("STUBELIUS_REFMODS_DIR")
    if env:
        out.append(env)
    out += list(folder_paths.folder_names_and_paths.get(FOLDER, ([], set()))[0])
    seen, uniq = set(), []
    for r in out:
        k = os.path.normcase(os.path.abspath(r))
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    return uniq


def save_root():
    """Where new RefMods go: the first existing refmods folder, else the first one (created)."""
    rs = roots()
    for r in rs:
        if os.path.isdir(r):
            return r
    os.makedirs(rs[0], exist_ok=True)
    return rs[0]


def find(name):
    """A RefMod's file: an absolute path, or a name (subfolders with /, with or without .safetensors) in a refmods
    folder."""
    if not name:
        return None
    name = str(name)
    if os.path.isabs(name):
        return name if os.path.isfile(name) else None
    rel = name if name.lower().endswith(".safetensors") else name + ".safetensors"
    parts = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    for r in roots():
        p = os.path.join(r, *parts)
        if os.path.isfile(p):
            return p
    return None


def meta_of(path):
    """The file's RefMod metadata (no tensors read), or None for anything else."""
    from safetensors import safe_open
    try:
        with safe_open(path, framework="pt", device="cpu") as f:
            return json.loads((f.metadata() or {}).get(META_KEY, "null"))
    except Exception:
        return None


def read(path):
    """Every visual reference in a RefMod file: [(latent [1,24,T,H,W] float, meta), ...]."""
    from safetensors import safe_open
    out = []
    with safe_open(path, framework="pt", device="cpu") as f:
        try:
            meta = json.loads((f.metadata() or {}).get(META_KEY, "{}"))
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


def _tokens(meta):
    t, h, w = int(meta.get("latent_t") or 1), int(meta.get("latent_h") or 0), int(meta.get("latent_w") or 0)
    return t * (h // 2) * (w // 2)


def listing():
    """Every RefMod in the refmods folders: name (relative, / separated, no extension), pictures, tokens, size,
    description, made by, thumbnail flag. Bundles count their visual members; audio-only files are left out."""
    items, seen = [], set()
    for root in roots():
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ("graph_presets", ".git", "__pycache__")]
            for fn in sorted(filenames):
                if not fn.lower().endswith(".safetensors"):
                    continue
                path = os.path.join(dirpath, fn)
                name = os.path.relpath(path, root).replace("\\", "/")[:-len(".safetensors")]
                if name in seen:
                    continue
                meta = meta_of(path)
                if not isinstance(meta, dict):
                    continue
                members = [m for m in meta.get("members") or []] if meta.get("kind") == "bundle" else [meta]
                visual = [m for m in members if isinstance(m, dict) and m.get("kind") in ("image", "video")]
                if not visual:
                    continue
                seen.add(name)
                first = visual[0]
                items.append({
                    "name": name, "pictures": sum(int(m.get("latent_t") or 1) for m in visual),
                    "tokens": sum(_tokens(m) for m in visual),
                    "width": int(first.get("latent_w") or 0) * 16, "height": int(first.get("latent_h") or 0) * 16,
                    "description": str(meta.get("description") or first.get("description") or ""),
                    "concept": str(first.get("concept_type") or ""), "mode": str(first.get("mode") or ""),
                    "tuned": "tuned" in json.dumps(meta).lower() or int(first.get("optimize_steps") or 0) > 0,
                    "maker": str(meta.get("stubelius") and "Stubelius" or ""),
                    "thumb": os.path.isfile(path[:-len(".safetensors")] + ".jpg"),
                    "bytes": os.path.getsize(path), "mtime": int(os.path.getmtime(path)),
                })
    items.sort(key=lambda x: x["name"].lower())
    return items


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
        try:
            strength = max(0.0, min(1.0, float(e.get("strength", 1.0))))
        except (TypeError, ValueError):
            strength = 1.0
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
    """Append the blocks to every entry's minimax_refs, as ComfyUI-MiniMaxH3Mod's Apply H3 RefMod does."""
    if not refs:
        return conditioning
    out = []
    for t in conditioning:
        d = dict(t[1])
        d["minimax_refs"] = list(d.get("minimax_refs", [])) + list(refs)
        out.append([t[0], d])
    return out


def stamp(entries):
    """What the takes key needs: each file's identity (size, time) and strength."""
    rows = []
    for e in entries or []:
        if not isinstance(e, dict) or e.get("enabled") is False:
            continue
        path = find(e.get("file"))
        st = os.stat(path) if path else None
        rows.append([str(e.get("file")), float(e.get("strength", 1.0)), [st.st_size, int(st.st_mtime)] if st else None])
    return rows


# ------------------------------------------------------------------------------------------- making one

def canvas(width, height, megapixels):
    """The picture size every picture is encoded at: the first picture's shape at that many megapixels, sides
    multiples of 32 (H3's VAE works in 16 px cells, the reference path in pairs of them)."""
    area = float(megapixels) * 1e6
    aspect = width / max(1, height)
    w = max(64, round((area * aspect) ** 0.5 / 32) * 32)
    h = max(64, round(w / aspect / 32) * 32)
    return int(w), int(h)


def _cover(image, w, h):
    """[1,H,W,C] -> [1,h,w,C]: scaled to cover, centre-cropped (pictures of other shapes keep their middle)."""
    _, ih, iw, _ = image.shape
    scale = max(w / iw, h / ih)
    nw, nh = max(w, round(iw * scale)), max(h, round(ih * scale))
    x = F.interpolate(image.permute(0, 3, 1, 2).float(), size=(nh, nw), mode="bicubic", align_corners=False, antialias=True)
    top, left = (nh - h) // 2, (nw - w) // 2
    return x[:, :, top:top + h, left:left + w].clamp(0, 1).permute(0, 2, 3, 1)


def _safe_name(name):
    parts = [re.sub(r"[^A-Za-z0-9 _.()-]", "", p).strip(" .") for p in str(name).replace("\\", "/").split("/")]
    parts = [p for p in parts if p]
    return "/".join(parts) or "character"


def make(vae, images, name, megapixels=0.5, description="", concept="identity", root=None):
    """Encode the pictures (a list of [1,H,W,C] 0..1) as one RefMod; write it (+ a contact sheet <name>.jpg) into
    the refmods folder. Returns (path, info)."""
    images = [im for im in images if im is not None][:MAX_PICTURES]
    if not images:
        raise ValueError("Make a character: no pictures")
    w, h = canvas(images[0].shape[2], images[0].shape[1], megapixels)
    latents = []
    for im in images:
        with torch.no_grad():
            z = vae.encode(_cover(im[:1, :, :, :3], w, h))
        latents.append(z.float().cpu())
    latent = torch.cat(latents, dim=2).to(torch.float16).contiguous()        # [1, 24, T, h/16, w/16]
    t, lh, lw = latent.shape[2], latent.shape[3], latent.shape[4]
    name = _safe_name(name)
    path = os.path.join(root or save_root(), *name.split("/")) + ".safetensors"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    meta = {"name": name.split("/")[-1], "kind": "video" if t > 1 else "image", "latent_h": lh, "latent_w": lw,
            "latent_t": t, "mode": "encode", "source": "image", "source_shape": f"{t}x{lh}x{lw}", "pool": "",
            "optimize_steps": 0, "tags": [], "description": str(description or ""), "concept_type": concept or "identity",
            "_format_version": 4, "sample_rate": 32000,
            "stubelius": {"made": int(time.time()), "megapixels": float(megapixels), "pictures": t, "size": [w, h]}}
    from safetensors.torch import save_file
    fd, tmp = tempfile.mkstemp(prefix=".refmod-", suffix=".tmp", dir=os.path.dirname(path))
    os.close(fd)
    try:
        save_file({"latent": latent}, tmp, metadata={META_KEY: json.dumps(meta)})
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    _contact_sheet(images, path[:-len(".safetensors")] + ".jpg")
    info = {"name": name, "pictures": t, "tokens": t * (lh // 2) * (lw // 2), "width": w, "height": h,
            "bytes": os.path.getsize(path)}
    log.info("[StubeliusRefMods] made %s: %d pictures at %dx%d, %d tokens", path, t, w, h, info["tokens"])
    return path, info


def _contact_sheet(images, path, tile=128, cols=4):
    from PIL import Image
    n = min(len(images), 8)
    rows = (n + cols - 1) // cols
    sheet = Image.new("RGB", (tile * min(n, cols), tile * rows), (16, 16, 20))
    for i, im in enumerate(images[:n]):
        x = _cover(im[:1, :, :, :3], tile, tile)[0].mul(255).round().byte().cpu().numpy()
        sheet.paste(Image.fromarray(x), ((i % cols) * tile, (i // cols) * tile))
    sheet.save(path, quality=88)


class StubeliusH3RefModMaker:
    """Make a character (RefMod) from pictures: each picture encoded once with H3's video VAE, all of them saved as
    one reference file in the refmods folder, ready for the Director's Characters lane."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video_vae": (folder_paths.get_filename_list("vae"), {"tooltip": "H3's video VAE (the Models node's)."}),
            "pictures": ("STRING", {"default": "[]", "multiline": True, "tooltip":
                                    "JSON list of pictures in ComfyUI's input folder (as the Director uploads them)."}),
            "name": ("STRING", {"default": "character"}),
            "megapixels": ("FLOAT", {"default": 0.5, "min": 0.25, "max": 2.0, "step": 0.05, "tooltip":
                                     "Size each picture is encoded at. 0.5 MP: ~500 tokens a picture; 1 MP: ~1,000."}),
            "description": ("STRING", {"default": "", "multiline": True}),
        }, "optional": {"images": ("IMAGE",)}}

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "Stubelius"
    OUTPUT_NODE = True

    def run(self, video_vae, pictures, name, megapixels, description, images=None):
        import comfy.sd
        import comfy.utils
        from PIL import Image, ImageOps
        pics = []
        if images is not None:
            pics += [images[i:i + 1] for i in range(images.shape[0])]
        try:
            files = json.loads(pictures or "[]")
        except ValueError:
            files = [p.strip() for p in str(pictures).splitlines() if p.strip()]
        top = os.path.abspath(folder_paths.get_input_directory())
        for rel in files:
            p = os.path.abspath(os.path.join(top, str(rel)))
            if os.path.commonpath([p, top]) != top or not os.path.isfile(p):
                log.warning("[StubeliusRefMods] picture not found in the input folder: %s", rel)
                continue
            img = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
            pics.append(torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0)[None])
        sd, metadata = comfy.utils.load_torch_file(folder_paths.get_full_path_or_raise("vae", video_vae), return_metadata=True)
        vae = comfy.sd.VAE(sd=sd, metadata=metadata)
        vae.throw_exception_if_invalid()
        path, info = make(vae, pics, name, megapixels, description)
        return {"ui": {"stubelius_refmod": [info]}}


NODE_CLASS_MAPPINGS = {"StubeliusH3RefModMaker": StubeliusH3RefModMaker}
NODE_DISPLAY_NAME_MAPPINGS = {"StubeliusH3RefModMaker": "Stubelius H3 Make a Character (RefMod)"}


def _routes():
    try:
        import asyncio
        from aiohttp import web
        from server import PromptServer
        routes = PromptServer.instance.routes
    except Exception:
        return

    @routes.get("/stubelius_ultimate_h3/refmods/list")
    async def _list(request):
        items = await asyncio.get_running_loop().run_in_executor(None, listing)
        return web.json_response({"items": items, "folder": save_root()})

    @routes.get("/stubelius_ultimate_h3/refmods/thumb")
    async def _thumb(request):
        name = request.query.get("name", "")
        path = None if os.path.isabs(name) else find(name)          # names only: inside the refmods folders
        if not path:
            return web.Response(status=404)
        jpg = path[:-len(".safetensors")] + ".jpg"
        return web.FileResponse(jpg, headers={"Cache-Control": "max-age=300"}) if os.path.isfile(jpg) else web.Response(status=404)


_routes()
