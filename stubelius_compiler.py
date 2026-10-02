"""ComfyUI's model compiler, paused while the Stubelius H3 nodes render.

ComfyUI 0.37 and newer (with dynamic VRAM) record how a model allocates its working memory on the
first sampler step and replay that recording from the second step on: the "Comfy model compiler",
on unless ComfyUI is started with --disable-comfy-compiler. With MiniMax H3 at the Quality size the
replay needs several GB more VRAM than the first step did. On an RTX 5090 (32 GB, ComfyUI 0.38) a
12 s Quality take and the 1.5x polish of a 10 s chunk both ran their first step at full speed and
then crawled (VRAM full, the H3 weights read over PCIe, no step in 5 minutes). With the compiler
off, the take ran 23-28 s a step and the polish 96 s a step, both at full power.

ComfyUI reads the switch on every model call, so turning it on for the length of a node turns the
compiler off for that node only. Every other node keeps it.
"""
import functools
import logging

log = logging.getLogger(__name__)
_said = False


def _args():
    try:
        from comfy.cli_args import args
    except Exception:
        return None
    return args if hasattr(args, "disable_comfy_compiler") else None


def compiler_paused(method):
    """Run a node's method with ComfyUI's model compiler off, and put the switches back after.
    Does nothing on a ComfyUI without the compiler, or one started with it off."""
    @functools.wraps(method)
    def run(*a, **k):
        global _said
        args = _args()
        if args is None or args.disable_comfy_compiler:
            return method(*a, **k)
        saved = (args.disable_comfy_compiler, getattr(args, "disable_cuda_graphs", None))
        args.disable_comfy_compiler = True
        if saved[1] is not None:
            args.disable_cuda_graphs = True
        if not _said:
            _said = True
            log.info("[Stubelius] ComfyUI's model compiler is off while the Stubelius H3 nodes render "
                     "(with it, Quality-size H3 ran out of VRAM from its second step on).")
        try:
            return method(*a, **k)
        finally:
            args.disable_comfy_compiler = saved[0]
            if saved[1] is not None:
                args.disable_cuda_graphs = saved[1]
    return run
