"""Sounds and clips on the timeline (First/Last Frame mode), each pinned at its own second.

timeline_data "cues": [{"kind": "sound" | "clip", "file", "fileName", "time", "sound": true}], time in
seconds of the whole video. ComfyUI's own "Add Guide for MiniMax H3" pins a sound or a clip at a frame
the way it pins a middle frame, so the video is made around it: a spoken line moves the lips, the
picture reacts to a sound at its moment, and a clip (real footage, or the best moment of another take)
plays as it is, with its own sound unless "sound" is false.

- A clip is pinned from its first frame, as long as H3's clip lengths allow (5, 22, 39, ... frames:
  17k + 5). It goes in the chunk whose new frames hold its start and has to fit in that chunk.
- A clip starts on H3's 17-frame grid (every 17/24 s): H3's video comes in groups of 17 frames, a token
  of 1 frame and four of 4, and so does a clip pinned with Add Guide. Pinned between two group starts,
  its tokens meet the video's out of step and the frames where they meet come out grey (measured: a
  wave clip at frame 72 matched its frames at 28 dB with two frames at 17 dB; at frame 68, 33 dB on
  every frame). So a clip moves to the nearest group start in its chunk, its own sound with it.
- A sound plays from its second to its end. Where it runs into the next chunk, each chunk pins its own
  part. Sounds that overlap are mixed into one.
- The Quality polish doesn't pin them again: the take already plays them (stubelius_polish.py).
"""
import logging
import math
import os

import torch
from comfy_extras.nodes_minimax_h3 import MiniMaxH3AddGuide

from . import stubelius_clip as _clip

log = logging.getLogger(__name__)

FPS = 24
MAX_CUES = 8
GRID = 17          # frames in one of H3's token groups: a clip starts on a multiple of it in its chunk


def clip_length(frames):
    """The longest clip H3 pins within `frames` frames: 5, 22, 39, ... (17k + 5), or 1 below 5."""
    frames = int(frames)
    return 1 if frames < 5 else frames - (frames - 5) % 17


class Cue:
    """One sound or clip on the timeline, ready to pin: `frame` = its first frame on the video's clock,
    `pictures` = a clip's frames at the render size, `sound` = AUDIO (a clip's own, or the sound's)."""

    def __init__(self, kind, name, time, pictures=None, sound=None):
        self.kind, self.name, self.time = kind, name, float(time)
        self.frame = int(round(self.time * FPS))
        self.pictures, self.sound = pictures, sound

    @property
    def frames(self):
        return int(self.pictures.shape[0]) if self.pictures is not None else 0


def load(tdata, resolve_path, duration_seconds, width, height, rate):
    """The timeline's sounds and clips that can be used, in time order (at most MAX_CUES): each one
    inside the video, a file that loads. Clips are read at width x height, sounds at `rate`."""
    found = []
    for entry in tdata.get("cues") or []:
        if not isinstance(entry, dict) or not entry.get("file") or entry.get("kind") not in ("sound", "clip"):
            continue
        name = entry.get("fileName") or entry["file"]
        try:
            time = float(entry.get("time"))
        except (TypeError, ValueError):
            log.warning("[StubeliusCues] %s has no time; left out", name)
            continue
        if not 0.0 <= time < float(duration_seconds):
            log.warning("[StubeliusCues] %s at %.2f s is outside the %.2f s video; left out",
                        name, time, float(duration_seconds))
            continue
        path = resolve_path(entry["file"])
        if not path or not os.path.exists(path):
            log.warning("[StubeliusCues] %s was not found; left out", name)
            continue
        if entry["kind"] == "clip":
            clip = _clip.open_clip(entry, resolve_path)
            if clip is None:
                continue
            count = clip_length(clip.frames)
            pictures = _clip.read(clip, width, height, count=count, from_start=True)
            sound = (_clip.sound(clip, seconds=count / FPS, rate=rate, from_start=True)
                     if entry.get("sound", True) else None)
            found.append(Cue("clip", name, time, pictures=pictures, sound=sound))
            log.info("[StubeliusCues] clip %s at %.2f s: %d frames%s", name, time, count,
                     ", with its sound" if sound is not None else "")
        else:
            decoded = _clip.decode_sound(path, rate, name)
            if decoded is None:
                log.warning("[StubeliusCues] %s has no sound; left out", name)
                continue
            wave, rate_read, _ = decoded
            found.append(Cue("sound", name, time, sound={"waveform": wave.unsqueeze(0), "sample_rate": rate_read}))
            log.info("[StubeliusCues] sound %s at %.2f s: %.2f s long", name, time, wave.shape[-1] / rate_read)
    found.sort(key=lambda c: c.time)
    if len(found) > MAX_CUES:
        log.warning("[StubeliusCues] %d sounds and clips; the first %d are used", len(found), MAX_CUES)
        found = found[:MAX_CUES]
    return found


def grid_start(index, frames, chunk_length, lead):
    """The chunk frame a clip of `frames` frames asked for at chunk frame `index` starts on: the nearest
    start of a 17-frame group after the carried-over frames (`lead`), or the one before it where the
    clip would run past the chunk from there. None when it runs past the chunk where it was asked, or
    no group start fits."""
    if index + frames > chunk_length:
        return None
    first = -(-int(lead) // GRID) * GRID
    at = max(int(round(index / GRID)) * GRID, first)
    if at + frames > chunk_length:
        at -= GRID
    return at if at >= first else None


def in_chunk(cues, frames_done, chunk_length, lead, is_last_chunk):
    """What this chunk pins: ([(frame index in the chunk, clip frames)], [(frame index, AUDIO)]).

    frames_done = frames of the finished video before this chunk's first new frame; lead = frames it
    opens with that are cut off again (a continuation's carry-over), so video frame g is chunk frame
    g - frames_done + lead. A clip lands in the chunk that holds its first frame (the last chunk takes
    what is left), on the nearest group start where it fits (grid_start); a sound is pinned where it
    plays in this chunk's new frames, the overlapping ones mixed."""
    end = math.inf if is_last_chunk else frames_done + chunk_length - lead   # the video frame after this chunk's
    clips, parts = [], []
    for cue in cues:
        frame = cue.frame
        if cue.kind == "clip":
            if not frames_done <= cue.frame < end:
                continue
            asked = cue.frame - frames_done + lead
            index = grid_start(asked, cue.frames, chunk_length, lead)
            if index is None:
                log.warning("[StubeliusCues] the clip %s at %.2f s (%d frames) runs past its chunk; left out",
                            cue.name, cue.time, cue.frames)
                continue
            frame = index + frames_done - lead
            if index != asked:
                log.info("[StubeliusCues] the clip %s starts at %.2f s (%+d frames), on H3's 17-frame grid",
                         cue.name, frame / FPS, index - asked)
            clips.append((index, cue.pictures))
        if cue.sound is None:
            continue
        rate, wave = cue.sound["sample_rate"], cue.sound["waveform"]
        start = frame / FPS                                         # seconds of the video
        here0, here1 = max(start, frames_done / FPS), min(start + wave.shape[-1] / rate, end / FPS)
        index = int(round(here0 * FPS)) - frames_done + lead
        if here1 <= here0 or index >= chunk_length:
            continue
        a, b = int(round((here0 - start) * rate)), int(round((here1 - start) * rate))
        parts.append((index, wave[..., a:b], rate))
    return clips, _mixed(parts)


def _mixed(parts):
    """Sound parts [(frame index, waveform, rate)] -> [(frame index, AUDIO)], overlapping ones mixed."""
    parts = sorted(parts, key=lambda p: p[0])
    merged = []
    for index, wave, rate in parts:
        if merged and index * rate / FPS < merged[-1][0] * rate / FPS + merged[-1][1].shape[-1]:
            first, held, _ = merged[-1]
            offset = int(round((index - first) * rate / FPS))
            length = max(held.shape[-1], offset + wave.shape[-1])
            mix = torch.zeros(held.shape[:-1] + (length,), dtype=held.dtype)
            mix[..., :held.shape[-1]] += held
            mix[..., offset:offset + wave.shape[-1]] += wave.to(held.dtype)
            merged[-1] = (first, mix.clamp_(-1.0, 1.0), rate)
        else:
            merged.append((index, wave, rate))
    return [(index, {"waveform": wave, "sample_rate": rate}) for index, wave, rate in merged]


def pin(execute, unpack, positive, latent, vae, audio_vae, clips, sounds):
    """The chunk's conditioning with its clips and sounds pinned (ComfyUI's Add Guide for MiniMax H3).
    `execute` / `unpack` = the Director's node runner."""
    for index, pictures in clips:
        positive = unpack(execute(MiniMaxH3AddGuide, positive=positive, latent=latent, frame_idx=int(index),
                                  vae=vae, image=pictures))[0]
    for index, audio in sounds:
        positive = unpack(execute(MiniMaxH3AddGuide, positive=positive, latent=latent, frame_idx=int(index),
                                  audio_vae=audio_vae, audio=audio))[0]
    return positive
