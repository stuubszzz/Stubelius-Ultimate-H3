"""Stubelius Color Lock — keep an enhancer's detail, take colour and tone from the original.

In LAB: L = low-pass(reference L) + high-pass(enhanced L); a, b from the reference. The
reference is resized to the enhanced size first. Anything an upscaler/enhancer did to colour
or broad lighting is discarded; only the fine detail it added survives. Default blur follows
the upscale factor (one source pixel), which is where new detail lives.
"""
import torch
import torch.nn.functional as F
import kornia

from comfy.model_management import get_torch_device


def _blur(x, sigma):
    return kornia.filters.gaussian_blur2d(x, (2 * int(3 * sigma) + 1,) * 2, (sigma, sigma), border_type="replicate")


class StubeliusColorLock:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "enhanced": ("IMAGE", {"tooltip": "Upscaled/enhanced frames (e.g. DLSS5 output)."}),
                "reference": ("IMAGE", {"tooltip": "The same frames before enhancement."}),
                "detail_radius": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 4.0, "step": 0.05,
                    "tooltip": "Blur radius in source pixels. 1.0 keeps all the added fine detail; "
                               "higher keeps coarser enhancer changes too (and some of its tone)."}),
                "batch_size": ("INT", {"default": 16, "min": 1, "max": 256}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    CATEGORY = "Stubelius"

    def run(self, enhanced, reference, detail_radius, batch_size, inplace=False):
        """inplace=True writes the result over `enhanced` (no second full-size copy). Only for a
        private tensor, like the Finish node's own DLSS5 output; as a node it never touches its input."""
        n = min(enhanced.shape[0], reference.shape[0])
        if enhanced.shape[0] != reference.shape[0]:
            raise ValueError(f"[StubeliusColorLock] frame counts differ: enhanced {enhanced.shape[0]}, "
                             f"reference {reference.shape[0]}")
        h, w = enhanced.shape[1:3]
        sigma = max(0.5, detail_radius * w / reference.shape[2])
        device = get_torch_device()
        if (inplace and enhanced.dtype == torch.float32 and enhanced.shape[3] == 3
                and enhanced.device.type == "cpu" and enhanced.is_contiguous()):
            out = enhanced
        else:
            out = torch.empty((n, h, w, 3), dtype=torch.float32)
        with torch.inference_mode():
            for s in range(0, n, batch_size):
                e = enhanced[s:s + batch_size, ..., :3].permute(0, 3, 1, 2).to(device, torch.float32)
                r = reference[s:s + batch_size, ..., :3].permute(0, 3, 1, 2).to(device, torch.float32)
                if r.shape[2:] != e.shape[2:]:
                    r = F.interpolate(r, size=(h, w), mode="bicubic", align_corners=False).clamp(0, 1)
                el, rl = kornia.color.rgb_to_lab(e), kornia.color.rgb_to_lab(r)
                L = _blur(rl[:, :1], sigma) + (el[:, :1] - _blur(el[:, :1], sigma))
                res = kornia.color.lab_to_rgb(torch.cat([L, rl[:, 1:]], 1)).clamp(0, 1)
                out[s:s + batch_size] = res.permute(0, 2, 3, 1).cpu()
        return (out,)


NODE_CLASS_MAPPINGS = {"StubeliusColorLock": StubeliusColorLock}
NODE_DISPLAY_NAME_MAPPINGS = {"StubeliusColorLock": "Stubelius Color Lock"}
