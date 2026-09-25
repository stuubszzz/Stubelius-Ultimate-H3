"""Stubelius Ultimate H3: one MiniMax H3 workflow for ComfyUI.

Registers only the Ultimate H3 nodes. The Director / Refine engines underneath are the Muse
Minimax Director V1.2 code (MIT, see NOTICE), carried here as modules so this pack installs next
to Stubelius-Director / Muse Director without clashing: its server routes live under
/stubelius_ultimate_h3/ and its front-end extensions have their own names.
"""
from .stubelius_v2 import (
    NODE_CLASS_MAPPINGS as _V2_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _V2_NODE_DISPLAY_NAME_MAPPINGS,
)
from .stubelius_h3_pipeline import (
    NODE_CLASS_MAPPINGS as _PIPE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _PIPE_NODE_DISPLAY_NAME_MAPPINGS,
)
from .stubelius_rife_fps import (
    NODE_CLASS_MAPPINGS as _RIFE_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _RIFE_NODE_DISPLAY_NAME_MAPPINGS,
)
from .stubelius_color_lock import (
    NODE_CLASS_MAPPINGS as _LOCK_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as _LOCK_NODE_DISPLAY_NAME_MAPPINGS,
)

NODE_CLASS_MAPPINGS = {
    **_V2_NODE_CLASS_MAPPINGS,
    **_PIPE_NODE_CLASS_MAPPINGS,
    **_RIFE_NODE_CLASS_MAPPINGS,
    **_LOCK_NODE_CLASS_MAPPINGS,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    **_V2_NODE_DISPLAY_NAME_MAPPINGS,
    **_PIPE_NODE_DISPLAY_NAME_MAPPINGS,
    **_RIFE_NODE_DISPLAY_NAME_MAPPINGS,
    **_LOCK_NODE_DISPLAY_NAME_MAPPINGS,
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
