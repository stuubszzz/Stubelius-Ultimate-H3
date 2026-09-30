"""Quality polish of a take that runs past one chunk.

The polish renders a finished take again at twice its size. It was handed one latent per take,
and for a video longer than one chunk that was the last chunk's: a 30 s video came back from a
Quality polish as its last 10 s.

The Director now keeps every chunk of a take (its finished latent, its own prompt, what it was
made from), and this module polishes the chunks in order and joins them the way the Director
joined the originals:

- each chunk with the checkpoint that made it (Reference for an Omni chunk, First/Last-Frame for
  a chunk made from keyframes, which is every chunk that extends a video), with its own prompt
  and its own LoRAs;
- a chunk that continues the one before it starts from that chunk's polished last frame and
  holds its polished last frames (the Director's own carry-over), so a seam is polished as one
  picture;
- the same opening frames cut off each chunk and the same seam smoothing. The polished video
  has exactly the take's frames, so the take's own sound still fits it: the polish re-renders
  the picture and never the sound.
"""
import logging

import torch

import comfy.sd
import node_helpers
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo

from .muse_minimax_refine import (_execute_comfy_node, _fit_image_to_target, _refine_one_chunk,
                                  _unpack_node_result)

log = logging.getLogger(__name__)

# On a candidate latent: {"chunks": [one record per chunk], "carry_length": frames the Director
# carried over (0 = none), "seam_frames": frames smoothed at a seam, "resize_method": how the
# first/last frame images were fitted}. Written by MuseMinimaxDirector._run_pass.
KEY = "_stubelius_chunks"


def chunks_of(candidate):
    """The chunks the Director kept for this take; [] for a take without them."""
    bundle = candidate.get(KEY) if isinstance(candidate, dict) else None
    return (bundle or {}).get("chunks") or []


HEAVY_TOKENS = 100_000          # a polish with more video tokens than this gets the memory savers below
FF_TOKENS_PER_PIECE = 60_000    # the feed-forward runs in pieces of about this many tokens


def polish_tokens(latent):
    """How many video tokens the polish of this latent runs on: the polish doubles both sides and
    the model packs 2x2 latent cells into one token, so it is one token per cell of the take's
    own latent (a 6.6 s chunk at the Quality preset: 190,000; one that continues a video, which
    also holds the frames it repeats: 250,000; a 10 s take in one chunk: 290,000). 0 when the
    latent isn't a video latent."""
    samples = latent["samples"]
    video = samples.unbind()[0] if getattr(samples, "is_nested", False) else samples
    if not torch.is_tensor(video) or video.ndim != 5:
        return 0
    return int(video.shape[2]) * int(video.shape[3]) * int(video.shape[4])


def save_vram(model, tokens):
    """Cut the polish's peak VRAM without changing its result.

    A chunk of 250,000 tokens asked for 13.7 GB in one piece for its feed-forward and ran out of
    memory on a 32 GB card; a 10 s take in one chunk (290,000) spilled over into system RAM and
    crawled (40 minutes without finishing a step). KJNodes' two MiniMax H3 patches (the ones
    behind the Models node's low-VRAM switches) run the feed-forward in pieces and the attention
    in head groups; both give the same output as the unpatched model. Left alone when KJNodes
    isn't installed or the polish is small."""
    from nodes import NODE_CLASS_MAPPINGS
    if tokens < HEAVY_TOKENS:
        return model
    feed_forward = NODE_CLASS_MAPPINGS.get("MiniMaxChunkFeedForward")
    attention = NODE_CLASS_MAPPINGS.get("MiniMaxLowVRAMAttention")
    pieces = min(64, max(2, -(-tokens // FF_TOKENS_PER_PIECE)))
    if feed_forward is not None:
        model = _unpack_node_result(_execute_comfy_node(feed_forward, model=model, chunks=pieces, seq_threshold=4096))[0]
    if attention is not None:
        model = _unpack_node_result(_execute_comfy_node(attention, model=model, head_chunks=4))[0]
    log.info("[StubeliusPolish] %d video tokens: feed-forward in %s, attention %s", tokens,
             f"{pieces} pieces" if feed_forward is not None else "one piece (KJNodes not installed)",
             "in 4 head groups" if attention is not None else "as it is")
    return model


def _model(models, chunk, node_id):
    """The checkpoint that made this chunk, with the chunk's own LoRAs, as the Director had it."""
    from .stubelius_v2 import _lora_state_dict
    model = models.model(chunk["model"])
    for _, path, strength in chunk.get("loras") or []:
        model, _ = comfy.sd.load_lora_for_models(model, None, _lora_state_dict(path), strength, 0)
    return models.preview(save_vram(model, polish_tokens(chunk["latent"])), node_id)


def _conditioning(chunk, bundle, clip, vae, previous):
    """How the chunk is conditioned for its polish: the way it was when it was made.

    -> (reference images, conditioning maker). A Reference (Omni) chunk returns its reference
    images and the Refine builds the conditioning from them as it does for a one-chunk take. A
    chunk made from keyframes returns a function (width, height) -> conditioning for that size.
    `previous` = the polished frames of the chunk before this one."""
    keyframes = chunk.get("keyframes")
    if keyframes is None:
        refs = dict(chunk.get("ref_images") or {})
        if chunk.get("anchor") and previous is not None:
            refs[chunk["anchor"]] = previous[-1:]
        return (refs or None), None

    def at(width, height):
        video = chunk["latent"]["samples"].unbind()[0]
        made_w, made_h = int(video.shape[-1]) * 16, int(video.shape[-2]) * 16
        how = bundle.get("resize_method") or "crop"
        first, last = keyframes.get("first"), keyframes.get("last")
        continues = isinstance(first, str)      # "previous": it starts on the last frame before it
        if continues:
            first = previous[-1:] if previous is not None else None
        # The text and the pictures the text encoder reads: exactly as when the chunk was made,
        # at the size it was made at.
        positive = _unpack_node_result(_execute_comfy_node(
            MiniMaxH3ImageToVideo, clip=clip, vae=vae, prompt=chunk["prompt"], width=made_w, height=made_h,
            length=int(chunk["length"]),
            first_frame=first if continues else _fit_image_to_target(first, made_w, made_h, how),
            last_frame=_fit_image_to_target(last, made_w, made_h, how)))[0]
        # The keyframes themselves are frames of the video, so they have to be on the grid the
        # polish samples at: the same pictures again, at that size (a polished frame is already
        # there; an uploaded image is fitted from the original, not enlarged from the small copy).
        pictures = [p for p in (first if continues else _fit_image_to_target(first, width, height, how),
                                _fit_image_to_target(last, width, height, how)) if p is not None]
        if not pictures or (width, height) == (made_w, made_h):
            return positive
        made = list(positive[0][1].get("minimax_keyframes") or [])
        if len(made) != len(pictures):
            raise RuntimeError(f"[StubeliusPolish] {len(pictures)} keyframe picture(s) but the conditioning "
                               f"holds {len(made)}: this ComfyUI's MiniMax H3 nodes changed, update the pack.")
        resized = []
        for keyframe, picture in zip(made, pictures):
            picture = picture[:1, :, :, :3]
            if tuple(picture.shape[1:3]) != (height, width):
                picture = _fit_image_to_target(picture, width, height, "stretch")
            resized.append({**keyframe, "latent": vae.encode(picture)})
        return node_helpers.conditioning_set_values(positive, {"minimax_keyframes": resized})

    return None, at


def _smooth_seam(last_frame, frames, count):
    """The Director's seam smoothing on the polished frames: the first `count` frames after a
    seam become RIFE in-betweens of the two frames around them. In place, the length stays."""
    from nodes import NODE_CLASS_MAPPINGS
    count = min(int(count or 0), int(frames.shape[0]) - 1)
    if count <= 0:
        return
    rife = NODE_CLASS_MAPPINGS.get("RIFE VFI")
    if rife is None:
        log.warning("[StubeliusPolish] seam left as a hard cut: the RIFE VFI node "
                    "(ComfyUI-Frame-Interpolation) isn't installed.")
        return
    pair = torch.cat([last_frame.to(frames), frames[count:count + 1]], dim=0)
    between = _unpack_node_result(_execute_comfy_node(
        rife, ckpt_name="rife49.pth", frames=pair, clear_cache_after_n_frames=10, multiplier=count + 1,
        fast_mode=True, ensemble=True, scale_factor=1.0, dtype="float32", torch_compile=False, batch_size=1))[0][1:-1]
    if between.shape[0] > 0:
        frames[:between.shape[0]] = between.to(frames)


def _ram_note(frames, candidate):
    """Say so up front when the polished frames alone won't fit in RAM (12 bytes a pixel)."""
    try:
        import psutil
        video = chunks_of(candidate)[0]["latent"]["samples"].unbind()[0]
        width, height = int(video.shape[-1]) * 32, int(video.shape[-2]) * 32
        need, total = frames * width * height * 12, psutil.virtual_memory().total
        if need > 0.6 * total:
            log.warning("[StubeliusPolish] %d polished frames at about %dx%d need %.0f GB of RAM on this %.0f GB "
                        "machine: expect a heavy slowdown. A shorter video or Hybrid mode avoids it.",
                        frames, width, height, need / 1e9, total / 1e9)
    except Exception:
        pass


def polish(candidate, models, strength, steps, method, frames=None, node_id=None):
    """The whole take, polished chunk by chunk: IMAGE [frames, height, width, 3].

    candidate = the take's latent as the Director returned it (takes["latents"][n]); frames =
    how many frames the take has, which is what the chunks add up to."""
    bundle = candidate[KEY]
    chunks = bundle["chunks"]
    made = candidate.get("_muse_stage1_settings") or {}
    carry_length = int(bundle.get("carry_length") or 0)
    clip, vae, audio_vae = models.clip(), models.vae(), models.audio_vae()
    if frames:
        _ram_note(int(frames), candidate)

    out, done, previous, previous_audio = None, 0, None, None
    for index, chunk in enumerate(chunks):
        refs, positive = _conditioning(chunk, bundle, clip, vae, previous)
        images, audio = _refine_one_chunk(
            _model(models, chunk, node_id), clip, vae, audio_vae, chunk["prompt"], chunk["latent"],
            made.get("ref_image_size", "match"), int(made.get("seed", 0)), int(made.get("steps", 8)),
            int(made.get("first_pass_steps", 2)), made.get("sampler_name", "euler"), made.get("scheduler", "beta"),
            2.0, method, refs,
            previous if carry_length else None, previous_audio if carry_length else None, carry_length,
            log_label=f"chunk {index + 1}/{len(chunks)}", audio_lock=True,
            refine_denoise=strength, polish_steps=steps, two_stage_strategy="complete then polish (stubelius)",
            positive=positive, trim_frames=int(chunk.get("trim") or 0))
        if previous is not None:
            _smooth_seam(previous[-1:], images, bundle.get("seam_frames"))

        # One tensor for the whole video, filled chunk by chunk: a chunk's own frames are let go
        # as soon as they are in it (at this size a 10 s chunk is about 13 GB).
        count = int(images.shape[0])
        if out is None:
            out = torch.empty((max(int(frames or 0), count),) + tuple(images.shape[1:]), dtype=images.dtype)
        if done + count > out.shape[0]:
            out = torch.cat([out[:done], images.to(out)], dim=0)
        else:
            out[done:done + count] = images
        previous, previous_audio = out[done:done + count], audio
        done += count
        del images

    if frames and done != int(frames):
        log.warning("[StubeliusPolish] the polished chunks add up to %d frames, the take has %d: "
                    "sound and picture may not end together.", done, int(frames))
    log.info("[StubeliusPolish] %d chunks polished and joined: %d frames at %dx%d.",
             len(chunks), done, out.shape[2], out.shape[1])
    return out[:done]
