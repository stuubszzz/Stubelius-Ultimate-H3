"""Middle frames for First/Last Frame mode: up to two pictures the video passes through, each at its own time.

The timeline keeps them in timeline_data "middle_frames": [{"file", "fileName", "time"}], time in seconds of
the whole video. The Director's timeline shows them as thumbnails you drag along the ruler; the Director
puts each one in the chunk whose new frames hold that moment, on the same clock as the Lip Sync recording
(a chunk that continues the video opens on frames that are cut off again after decoding).

MiniMax H3 anchors a keyframe anywhere on the video's time axis: the first and last frame are two such
anchors, and ComfyUI's own "Add Guide for MiniMax H3" places more, one per middle frame; the text encoder
sees only the first and last frame, as in ComfyUI's own multiframe template. timeline_data
"middle_frames_in_text": true also shows the middle pictures to the text encoder, as <Picture 2>,
<Picture 3> between the first and the last frame, with the second each one is reached in the prompt.
That is not the default: in a chunk that continues the video it made Quality and Hybrid stall and
then jump to the middle frame, and Add Guide alone reaches the same picture without the jump.
"""
import logging

import comfy.utils
import node_helpers
from comfy_extras.nodes_minimax_h3 import (
    EmptyMiniMaxH3LatentAV, MiniMaxH3AddGuide, MiniMaxH3ImageToVideo, align_frame_count,
)

log = logging.getLogger(__name__)

MAX_MIDDLE_FRAMES = 2
FPS = 24


def load(tdata, load_image, duration_seconds):
    """The timeline's middle frames that can be used, in time order: [{"time", "source", "file"}],
    at most MAX_MIDDLE_FRAMES, each inside the video, each an image that loads."""
    found = []
    for entry in tdata.get("middle_frames") or []:
        if not isinstance(entry, dict) or not entry.get("file"):
            continue
        try:
            time = float(entry.get("time"))
        except (TypeError, ValueError):
            log.warning("[StubeliusH3] middle frame %s has no time; left out", entry.get("fileName") or entry["file"])
            continue
        if not 0.0 < time < float(duration_seconds):
            log.warning("[StubeliusH3] middle frame %s at %.2f s is outside the %.2f s video; left out",
                        entry.get("fileName") or entry["file"], time, float(duration_seconds))
            continue
        source = load_image(entry)
        if source is None:
            continue
        found.append({"time": time, "source": source, "file": entry["file"]})
    found.sort(key=lambda m: m["time"])
    if len(found) > MAX_MIDDLE_FRAMES:
        log.warning("[StubeliusH3] %d middle frames; the first %d are used", len(found), MAX_MIDDLE_FRAMES)
        found = found[:MAX_MIDDLE_FRAMES]
    return found


def in_chunk(middles, claimed, frames_done, visible_length, chunk_length, lead, is_last_chunk):
    """The middle frames this chunk renders: [(frame index in the chunk, middle frame)], in time order.

    frames_done = frames of the finished video before this chunk's first new frame; lead = frames the
    chunk opens with that are cut off again after decoding (a continuation chunk's carry-over), so frame
    g of the video is frame g - frames_done + lead of this chunk. A middle frame belongs to the chunk
    whose new frames hold it, the last chunk takes what is left, and `claimed` (indices into
    `middles`, shared by the chunks of one take) keeps it from landing twice. Never on the chunk's own
    first or last frame: those are the first/last frame anchors."""
    first_free = lead + 1 if lead else 1
    last_free = chunk_length - 2
    placed = []
    for i, middle in enumerate(middles):
        if i in claimed:
            continue
        frame = round(middle["time"] * FPS)
        if not is_last_chunk and frame >= frames_done + visible_length:
            continue
        index = min(max(frame - frames_done + lead, first_free), last_free)
        if placed and index <= placed[-1][0]:
            index = placed[-1][0] + 1
        claimed.add(i)
        if index > last_free:
            log.warning("[StubeliusH3] no room for the middle frame at %.2f s in this chunk; left out", middle["time"])
            continue
        placed.append((index, middle))
    return placed


def shot_at(segments, time):
    """Number of the [Shot N] that is playing at `time` (seconds of the whole video): CUTs with text
    count as shots, in order, each from its own start."""
    shot = 0
    for seg in segments:
        if not (seg.get("prompt") or "").strip():
            continue
        if shot and float(seg.get("_abs_start", 0.0)) > time + 1e-6:
            break
        shot += 1
    return max(1, shot)


def _fit(image, width, height, crop):
    """An image as the target's [1, height, width, 3]; resampled only when it isn't that size already."""
    samples = image[:1, :, :, :3].movedim(-1, 1)
    if tuple(samples.shape[-2:]) != (height, width):
        samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)


class KeyframesToVideo:
    """MiniMax H3 Image to Video with middle frames the text encoder sees as well.

    The pictures go to the text encoder in time order (first frame, middle frames, last frame), so they
    are <Picture 1> .. <Picture N> in the prompt, and each one is anchored at its own frame, the way
    ComfyUI's node anchors the first and last frame (the first stretched to the canvas, the others
    cover-cropped, as there)."""

    @classmethod
    def execute(cls, clip, vae, prompt, width, height, length, first_frame=None, last_frame=None,
                middle_frames=()):
        out = EmptyMiniMaxH3LatentAV.execute(width=width, height=height, length=length)
        latent = getattr(out, "result", out)[0]
        frame_count = align_frame_count(max(5, int(length)))
        anchors = []
        if first_frame is not None:
            anchors.append((0, _fit(first_frame, width, height, "disabled")))
        for index, picture in sorted(middle_frames, key=lambda m: m[0]):
            anchors.append((int(index), _fit(picture, width, height, "center")))
        if last_frame is not None:
            anchors.append((frame_count - 1, _fit(last_frame, width, height, "center")))
        tokens = clip.tokenize(prompt, images=[picture for _, picture in anchors])
        positive = clip.encode_from_tokens_scheduled(tokens)
        if anchors:
            keyframes = [{"resolved_frame_index": index, "latent": vae.encode(picture)} for index, picture in anchors]
            positive = node_helpers.conditioning_set_values(positive, {"minimax_keyframes": keyframes})
        return (positive, latent)


def conditioning(execute, unpack, clip, vae, prompt, width, height, length, first=None, last=None,
                 middles=(), in_text=False):
    """(positive, latent) for one chunk made from keyframes. middles = [(frame index in the chunk, picture)].
    `execute` / `unpack` = the caller's node runner (the Director's and the polish's own)."""
    if not middles:
        return tuple(unpack(execute(MiniMaxH3ImageToVideo, clip=clip, vae=vae, prompt=prompt, width=width,
                                    height=height, length=length, first_frame=first, last_frame=last))[:2])
    if in_text:
        return tuple(unpack(execute(KeyframesToVideo, clip=clip, vae=vae, prompt=prompt, width=width,
                                    height=height, length=length, first_frame=first, last_frame=last,
                                    middle_frames=list(middles)))[:2])
    positive, latent = tuple(unpack(execute(MiniMaxH3ImageToVideo, clip=clip, vae=vae, prompt=prompt, width=width,
                                            height=height, length=length, first_frame=first,
                                            last_frame=last))[:2])
    for index, picture in middles:
        positive = unpack(execute(MiniMaxH3AddGuide, positive=positive, latent=latent, frame_idx=int(index),
                                  vae=vae, image=picture[:1]))[0]
    return positive, latent
