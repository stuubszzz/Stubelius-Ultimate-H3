# Stubelius Ultimate H3 · Saved references the shots can name
"""Saved references (characters, outfits, locations, items) in H3's own reference slots.

A saved character (stubelius_refmods.py) rides H3's reference path as a latent: the picture influences the render,
but the text encoder never sees it, so the shots can't name it. That is enough for "this person", and not enough for
"this person wearing that outfit" — the outfit has to be a `<Picture N>` the shots can point at. Saved with their
pictures, our references can take those slots: one saved character plus one saved outfit, swapped without re-making
anything.

How it reaches H3 (core's MiniMaxH3ReferenceToVideo does the same two things):
  - the pictures go to the text encoder, as `minimax_ref_items`, numbered `<Picture 1>`, `<Picture 2>`, ... in slot
    order — that is what makes them nameable;
  - their latents go to the model, as the conditioning's `minimax_refs`, in the same order.
We let core's node do the first half (so the numbering, the canvas and the empty latent stay core's own, with no VAE
given) and build the second half here, where a saved reference brings its latent already encoded. A picture used at
the size it was saved at costs no VAE encode at all — not on the first chunk, not on the ones after it, not on the
next render. A picture core would resize (a reference bigger in area than the output, or 'max' sizing) is encoded
once and kept for the rest of the session.

`conditioning()` is a drop-in for the Reference-mode call: same arguments, plus `ref_latents` for the slots that
already have one. With no saved references the Director keeps calling core's node directly, so this file only runs
when there is something saved to put in a slot. The CPU suite checks the blocks built here against core's own, so
the two can't drift apart quietly.
"""
import logging
import math
import os

import torch

import node_helpers
from comfy_extras.nodes_minimax_h3 import (
    CANVAS_MULTIPLE, FPS, REF_IMAGE_SHORT_EDGE, MiniMaxH3ReferenceToVideo, _encode_ref_audio, _resize, adapt_canvas,
)

from . import stubelius_refmods as _refmods

log = logging.getLogger(__name__)
MAX_PICTURE_SLOTS = 9           # core's own limit on ref_images
_CACHE = {}                     # (pack identity, picture, width, height) -> latent, for sizes we had to encode
_CACHE_MAX = 64


def target_size(width, height, out_width, out_height, ref_image_size):
    """The size core's reference node resizes a reference picture to, by its own maths: 'match' scales down (never
    up) to the render's pixel area, 'max' to a 2048 px short edge, both rounded to 32."""
    if ref_image_size == "match":
        scale = min(1.0, math.sqrt((out_width * out_height) / (width * height)))
    else:
        scale = min(1.0, REF_IMAGE_SHORT_EDGE / min(width, height))
    return (max(CANVAS_MULTIPLE, round(width * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
            max(CANVAS_MULTIPLE, round(height * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE))


def _cache_get(key):
    return _CACHE.get(key)


def _cache_put(key, latent):
    if len(_CACHE) >= _CACHE_MAX:
        for old in list(_CACHE)[:len(_CACHE) // 2 or 1]:
            _CACHE.pop(old, None)
    _CACHE[key] = latent


def _encode_image(vae, pixels, key):
    """One picture's latent: the one kept from an earlier chunk or render, else a real encode."""
    if key is not None:
        kept = _cache_get(key)
        if kept is not None:
            return kept
    with torch.no_grad():
        z = vae.encode(pixels)
    if key is not None:
        _cache_put(key, z)
    return z


def image_blocks(vae, ref_images, out_width, out_height, ref_image_size, ref_latents=None, report=None):
    """core's image reference blocks for a slot dict, in slot order. A slot in `ref_latents` whose latent was made
    at exactly the size this render uses brings it along; everything else is encoded (and kept)."""
    out = []
    saved = ref_latents or {}
    for name, image in (ref_images or {}).items():
        if image is None:
            continue
        h, w = int(image.shape[1]), int(image.shape[2])
        tw, th = target_size(w, h, out_width, out_height, ref_image_size)
        ready = saved.get(name) or {}
        if ready.get("latent") is not None and tuple(ready.get("size") or ()) == (tw, th):
            latent = ready["latent"]
            if report is not None:
                report.append(f"{name}: {ready.get('what') or 'saved'} at {tw}x{th}, encoded when it was saved")
        else:
            key = (*ready["key"], tw, th) if ready.get("key") else None
            latent = _encode_image(vae, _resize(image[:1], tw, th, "disabled"), key)
            if report is not None and ready:
                was = "x".join(str(v) for v in (ready.get("size") or ("?", "?")))
                report.append(f"{name}: {ready.get('what') or 'saved'} encoded at {tw}x{th} (saved at {was})")
        strength = float(ready.get("strength", 1.0))
        if 0.0 < strength < 1.0:
            latent = strength * latent + (1.0 - strength) * _refmods._blur(latent)
        out.append({"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": latent})
    return out


def video_blocks(vae, audio_vae, ref_videos, ref_video_audios, frame_count):
    """core's video reference blocks, same canvas and same 17n+5 trim as its own node."""
    out = []
    sounds = ref_video_audios or {}
    for name, frames in (ref_videos or {}).items():
        if frames is None:
            continue
        soundtrack = sounds.get("ref_video_audio_" + name.rsplit("_", 1)[-1])
        vh, vw = int(frames.shape[1]), int(frames.shape[2])
        cw, ch = adapt_canvas(vw, vh)
        if vw * vh < cw * ch:
            cw = max(CANVAS_MULTIPLE, round(vw / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
            ch = max(CANVAS_MULTIPLE, round(vh / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        clip = _resize(frames, cw, ch, "disabled")
        if clip.shape[0] > frame_count:
            clip = clip[:frame_count]
        n = clip.shape[0]
        if n < 5:
            raise ValueError("MiniMax H3 reference videos need at least 5 frames (~0.2s at 24 fps)")
        while n % 17 != 5:
            n -= 1
        clip = clip[:n]
        with torch.no_grad():
            z = vae.encode(clip)
        audio_latent, ref_audio_t = (None, 0)
        if soundtrack is not None and audio_vae is not None:
            audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, soundtrack)
        out.append({"kind": "video_audio" if ref_audio_t else "video",
                    "latent_t": z.shape[2], "latent_h": ch // 16, "latent_w": cw // 16,
                    "ref_audio_t": ref_audio_t, "latent": z, "audio_latent": audio_latent})
    return out


def audio_blocks(audio_vae, ref_audios):
    out = []
    for audio in (ref_audios or {}).values():
        if audio is None or audio_vae is None:
            continue
        audio_latent, ref_audio_t = _encode_ref_audio(audio_vae, audio)
        out.append({"kind": "audio", "ref_audio_t": ref_audio_t, "audio_latent": audio_latent})
    return out


def conditioning(execute_node, unpack, clip, vae, audio_vae, prompt, width, height, length, ref_image_size,
                 ref_images=None, ref_videos=None, ref_video_audios=None, ref_audios=None, ref_latents=None):
    """Reference-mode conditioning with the saved latents used where they fit: core's node builds what the text
    encoder sees (no VAE given, so it encodes nothing), the reference payload is built here in the same order."""
    out = execute_node(
        MiniMaxH3ReferenceToVideo,
        clip=clip, vae=None, audio_vae=None, prompt=prompt,
        width=width, height=height, length=length, ref_image_size=ref_image_size,
        ref_images=ref_images or None, ref_videos=ref_videos or None,
        ref_video_audios=ref_video_audios or None, ref_audios=ref_audios or None,
    )
    positive, latent = unpack(out)[:2]
    frame_count = _frames(latent, length)
    report = []
    blocks = image_blocks(vae, ref_images, width, height, ref_image_size, ref_latents, report)
    blocks += video_blocks(vae, audio_vae, ref_videos, ref_video_audios, frame_count)
    blocks += audio_blocks(audio_vae, ref_audios)
    if report:
        log.info("[StubeliusRefs] %s", "; ".join(report))
    if blocks:
        positive = node_helpers.conditioning_set_values(positive, {"minimax_refs": blocks})
    return positive, latent


def _frames(latent, length):
    """The frame count core's node settled on, read back from the latent it made (its own 17n+5 snapping)."""
    try:
        samples = latent["samples"]
        video = samples.unbind()[0] if getattr(samples, "is_nested", False) else samples
        return (int(video.shape[2]) - 2) // 5 * 17 + 5
    except Exception:
        n = max(5, int(length))
        while n % 17 != 5:
            n += 1
        return n


# ------------------------------------------------------------------- the saved references on the timeline

class Saved:
    """The saved references enabled on the timeline, split by how they can reach H3.

    `named` are the ones saved with their pictures: they take `<Picture N>` slots, so the shots can name them and a
    character can be given an outfit. `latent_only` are the older files (and the other packs'): they keep riding the
    latent path on every chunk, exactly as before.

    Picture slots exist in Reference mode only — First/Last Frame mode hands H3 its two frames and has no reference
    tags at all — so `named=False` (and a hybrid chunk inside Reference mode, through `latent_blocks()`) puts every
    saved reference back on the latent path, which works in both modes.
    """

    def __init__(self, entries, named=True):
        self.named, self.latent_only, self.dropped = [], [], []
        for entry in entries or []:
            if not isinstance(entry, dict) or entry.get("enabled") is False or not entry.get("file"):
                continue
            path = _refmods.find(entry.get("file"))
            if path is None:
                self.latent_only.append(entry)          # refmods logs the missing file and skips it
                continue
            meta = _refmods.meta_of(path)
            pics = _refmods.pictures(path) if named and isinstance(meta, dict) else []
            if not pics:
                self.latent_only.append(entry)
                continue
            role = _refmods.role_of(meta)
            if str(entry.get("role") or "").strip().lower() in _refmods.ROLES:
                role = str(entry["role"]).strip().lower()               # the lane can override the saved role
            try:
                refs = _refmods.read(path)
            except Exception as err:
                log.warning("[StubeliusRefs] '%s' couldn't be read (%s): left out", entry.get("file"), err)
                continue
            latents = _split(refs)
            stat = os.stat(path)
            name = str(entry.get("file"))
            self.named.append({
                "file": name, "name": name.split("/")[-1], "role": role,
                "description": str(entry.get("description") or (meta or {}).get("description") or "").strip(),
                "strength": _refmods._strength(entry),
                "pictures": pics, "latents": latents,
                "key": (os.path.abspath(path), stat.st_size, int(stat.st_mtime)),
            })
        self._budget()

    def _budget(self):
        """H3 takes 9 reference pictures. Characters first, then outfits, then the rest; what doesn't fit is said
        out loud rather than silently ignored."""
        order = {"character": 0, "outfit": 1, "location": 2, "item": 3}
        self.named.sort(key=lambda p: order.get(p["role"], 4))
        used, kept = 0, []
        for pack in self.named:
            room = MAX_PICTURE_SLOTS - used
            if room <= 0:
                self.dropped.append(pack["name"])
                continue
            if len(pack["pictures"]) > room:
                pack["pictures"] = pack["pictures"][:room]
                pack["latents"] = pack["latents"][:room]
                self.dropped.append(f"{pack['name']} (past its first {room} picture(s))")
            used += len(pack["pictures"])
            kept.append(pack)
        self.named = kept

    def any_named(self):
        return bool(self.named)

    def of_role(self, role):
        return [p for p in self.named if p["role"] == role]

    def slot_latents(self, slots):
        """`ref_latents` for conditioning(): which slot each saved picture ended up in, with the latent and the
        size it was encoded at. `slots` is [(slot name, pack, picture index), ...]."""
        out = {}
        for slot, pack, i in slots:
            latent, size = pack["latents"][i] if i < len(pack["latents"]) else (None, None)
            if latent is None:
                continue
            out[slot] = {"latent": latent, "size": size, "strength": pack["strength"],
                         "key": (*pack["key"], i), "what": f"{pack['name']} ({pack['role']})"}
        return out

    def latent_blocks(self):
        """The named packs on the latent path instead of in picture slots — for a chunk with no reference tags to
        put them in (a hybrid chunk): the same blocks, by the same code, as a file saved without its pictures."""
        return _refmods.blocks([{"file": p["file"], "strength": p["strength"]} for p in self.named])

    def stamp(self):
        """What the takes key needs: every named pack's identity, role and strength."""
        return [[p["file"], p["role"], p["strength"], list(p["key"][1:])] for p in self.named]


def _split(refs):
    """A file's references as one latent per picture: [(latent [1,24,1,h,w], (width, height)), ...]."""
    out = []
    for latent, meta in refs:
        if latent.dim() != 5:
            continue
        for i in range(latent.shape[2]):
            z = latent[:, :, i:i + 1].contiguous()
            out.append((z, (int(z.shape[4]) * 16, int(z.shape[3]) * 16)))
    return out
