"""Lip Sync past one chunk: the recording becomes every chunk's own sound.

A reference audio set to Lip Sync (retention fully_copy) is the video's soundtrack. H3 only takes
reference audio in Reference (Omni) mode, and the continuation chunks of a longer video run the
First/Last-Frame model, which has no audio input at all: chunk 1 followed the recording, every
later chunk invented its own speech.

So the recording is not handed over as a reference there. Each chunk's slice of it is encoded with
the audio VAE, written into that chunk's audio latent and masked out of the denoising (noise mask
0), and the model generates only the picture, against sound that is already final. The slice is
cut on the finished video's own clock (frame f of the video hears second f / 24 of the recording),
so the chunks line up however long each one came out.

The finished video then gets the recording itself as its sound, not the VAE's copy of it.

Where the recording is over, the soundtrack is silence and that is locked in the same way: a
talking head left to itself after the last word keeps talking (it invents speech, measured). Only
a chunk that starts after the recording's end AND has a spoken line of its own in its CUTs is
left to the model, which then speaks that line.

Needs a ComfyUI whose MiniMax H3 model applies a noise mask per stream (video, audio).
"""
import inspect
import logging
import math

import torch

log = logging.getLogger(__name__)

FPS = 24.0
LATENT_HZ = 40          # H3 audio latent frames per second
RELEASE_TICKS = 8       # silence_after off: a recording that ends inside a chunk lets go over 0.2 s
MIN_SECONDS = 0.5       # less recording than this left at a chunk's start: the recording is over there
END_FADE_SECONDS = 0.05
LIP_SYNC = "fully_copy"  # H3's own retention word, what the panel calls "Lip Sync"
SILENT = "Nobody speaks in this shot: the person on screen stays silent, lips closed."


def ends_note(seconds):
    """What a chunk's prompt says when the recording ends `seconds` into it."""
    return f"After {seconds:.1f} seconds nobody speaks: the person on screen stays silent, lips closed."


def has_spoken_line(segments):
    """Does any CUT of this chunk carry a spoken line? (quoted text, the panel's own convention)"""
    return any('"' in (seg.get("prompt") or "") for seg in segments or [])


def supported():
    """True when this ComfyUI can hold the audio half of an H3 latent still while it generates the
    video half (the H3 model takes a mask for each stream)."""
    try:
        import comfy.ldm.minimax.model as h3
        return "audio_denoise_mask" in inspect.signature(h3.MiniMaxH3Model.forward).parameters
    except Exception:
        return False


def _resample(waveform, source_rate, target_rate):
    if int(source_rate) == int(target_rate):
        return waveform
    import comfy.audio
    return comfy.audio.resample(waveform, int(source_rate), int(target_rate))


def window(audio, start_seconds, seconds):
    """[start, start + seconds) of an AUDIO dict, or None when nothing worth using is left there."""
    rate = int(audio["sample_rate"])
    a = max(0, int(round(start_seconds * rate)))
    b = a + max(0, int(round(seconds * rate)))
    part = audio["waveform"][..., a:b]
    if part.shape[-1] < MIN_SECONDS * rate:
        return None
    return {"waveform": part, "sample_rate": rate}


def _transcript_lines(ref_audio_entries):
    """[(start in the video, text)] of the Lip Sync recordings, from the panel's own Whisper
    transcript (its times run on the uploaded file, so the trim-in is taken off)."""
    lines = []
    for entry in ref_audio_entries or []:
        if not entry or entry.get("retention") != LIP_SYNC:
            continue
        offset = float(entry.get("trimStartSec", 0) or 0)
        for seg in entry.get("transcript_segments") or []:
            text = (seg.get("text") or "").strip()
            if text:
                lines.append((float(seg.get("start", 0) or 0) - offset, text))
    return sorted(lines)


def transcript_text(ref_audio_entries, start_seconds, end_seconds):
    """The words the Lip Sync recordings say in [start, end) of the video."""
    return " ".join(text for at, text in _transcript_lines(ref_audio_entries) if start_seconds <= at < end_seconds)


def line_key(text):
    """A spoken line reduced to its letters and digits, so a CUT's quote finds its transcript line
    whatever happened to the punctuation in between."""
    return "".join(ch for ch in (text or "").lower() if ch.isalnum())


def line_starts(ref_audio_entries):
    """{line_key: when that line starts in the video} for the Lip Sync transcripts."""
    starts = {}
    for at, text in _transcript_lines(ref_audio_entries):
        starts.setdefault(line_key(text), at)
    return starts


class Soundtrack:
    """The Lip Sync recordings of one run, mixed onto the video's timeline (0 s = its first frame)."""

    def __init__(self, waveform, sample_rate):
        self.waveform = waveform            # [1, 2, samples], float32, cpu
        self.sample_rate = int(sample_rate)
        self._at_rate = {}

    @classmethod
    def from_refs(cls, user_ref_audios):
        """user_ref_audios: the Director's [(AUDIO, entry, slot)] list. Two recordings set to
        Lip Sync (two characters) share the timeline, so they are added together."""
        clips = [audio for audio, entry, _ in user_ref_audios or [] if (entry or {}).get("retention") == LIP_SYNC]
        if not clips:
            return None
        rate = int(clips[0]["sample_rate"])
        waves = []
        for clip in clips:
            wave = clip["waveform"][:1].to(torch.float32).cpu()
            if wave.shape[1] == 1:
                wave = wave.repeat(1, 2, 1)
            waves.append(_resample(wave[:, :2], clip["sample_rate"], rate))
        length = max(w.shape[-1] for w in waves)
        mix = torch.zeros((1, 2, length), dtype=torch.float32)
        for w in waves:
            mix[..., :w.shape[-1]] += w
        peak = float(mix.abs().max()) if length else 0.0
        if len(waves) > 1 and peak > 1.0:
            mix /= peak
        if length < MIN_SECONDS * rate:
            return None
        return cls(mix, rate)

    @property
    def seconds(self):
        return self.waveform.shape[-1] / self.sample_rate

    def covers(self, at_seconds):
        """Is there still recording to follow at this point of the video?"""
        return self.seconds - at_seconds >= MIN_SECONDS

    def at_rate(self, rate):
        rate = int(rate)
        if rate not in self._at_rate:
            self._at_rate[rate] = _resample(self.waveform, self.sample_rate, rate)
        return self._at_rate[rate]

    def lock(self, latent, audio_vae, start_seconds, silence_after=True):
        """Write the recording from `start_seconds` on into this chunk's audio latent and take it
        out of the denoising. Returns (latent, audio latent frames locked, of those the recording);
        0 locked = left untouched.

        start_seconds is where the chunk's FIRST latent frame sits in the finished video. A
        continuation chunk starts on frames that repeat the end of the chunk before it (cut off
        again after decoding), so that is earlier than where its new frames begin.

        silence_after: once the recording is over, the soundtrack is silence, and that is locked
        in as well (a talking head left to itself after the last word keeps talking: it invents
        speech). False = let go 0.2 s before the recording's end and hand the rest to the model."""
        from comfy.nested_tensor import NestedTensor

        streams = latent["samples"].unbind()
        video, audio = streams[0], streams[1]
        ticks = int(audio.shape[-1])
        rate = int(getattr(audio_vae, "audio_sample_rate", 32000))
        hop = rate // LATENT_HZ
        if hop * LATENT_HZ != rate:
            raise RuntimeError(f"[StubeliusLipSync] audio VAE rate {rate} Hz doesn't fit H3's {LATENT_HZ} Hz audio latent")
        track = self.at_rate(rate)
        start = max(0, int(round(start_seconds * rate)))
        covered = min(ticks, max(0, track.shape[-1] - start) // hop)
        if not silence_after and covered * hop < MIN_SECONDS * rate:
            return latent, 0, 0

        pcm = track[..., start:start + ticks * hop]
        if pcm.shape[-1] < ticks * hop:      # the recording ends inside this chunk: silence after it
            pcm = torch.nn.functional.pad(pcm, (0, ticks * hop - pcm.shape[-1]))
        with torch.no_grad():
            encoded = audio_vae.encode(pcm.movedim(1, -1))      # [1, 32, 2, ticks]
        n = min(ticks if silence_after else covered, int(encoded.shape[-1]))
        locked_audio = audio.clone()
        locked_audio[..., :n] = encoded[..., :n].to(device=audio.device, dtype=audio.dtype)

        masks = latent.get("noise_mask")
        if masks is not None and getattr(masks, "is_nested", False):
            # a continuation chunk already holds its first frames (the carry-over): keep that
            video_mask, audio_mask = masks.unbind()[:2]
            audio_mask = audio_mask.clone()
        else:
            video_mask = torch.ones((1, 1) + tuple(video.shape[2:]), dtype=torch.float32, device=video.device)
            audio_mask = torch.ones((1, 1) + tuple(audio.shape[2:]), dtype=torch.float32, device=audio.device)
        audio_mask[..., :n] = 0.0
        if n < ticks:
            r = min(RELEASE_TICKS, n)
            steps = torch.arange(1, r + 1, dtype=torch.float32, device=audio_mask.device) / (r + 1)
            audio_mask[..., n - r:n] = 0.5 - 0.5 * torch.cos(steps * math.pi)

        out = dict(latent)
        out["samples"] = NestedTensor((video, locked_audio))
        out["noise_mask"] = NestedTensor((video_mask, audio_mask))
        return out, n, min(covered, n)

    def lay_over(self, audio):
        """The finished AUDIO with the recording itself over the part of the video it covers."""
        wave, rate = audio["waveform"], int(audio["sample_rate"])
        track = self.at_rate(rate)[..., :wave.shape[-1]]
        n = int(track.shape[-1])
        if n == 0:
            return audio
        if wave.shape[1] == 1:
            track = track.mean(dim=1, keepdim=True)
        track = track.to(device=wave.device, dtype=wave.dtype).expand(wave.shape[0], -1, -1)
        out = wave.clone()
        fade = min(int(END_FADE_SECONDS * rate), n) if n < wave.shape[-1] else 0
        out[..., :n - fade] = track[..., :n - fade]
        if fade:    # the recording ends before the video does: hand over to the generated sound
            down = torch.linspace(1.0, 0.0, fade, device=wave.device, dtype=wave.dtype)
            out[..., n - fade:n] = track[..., n - fade:n] * down + wave[..., n - fade:n] * (1.0 - down)
        result = dict(audio)
        result["waveform"] = out
        return result
