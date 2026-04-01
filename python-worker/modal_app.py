"""
Modal deployment for the Virtual Cell python-worker (DrugCLIP inference).

Prerequisites
-------------
1. Install the Modal client locally (one-time):
       pip install modal
       modal token new

2. From the repo root (or python-worker/ dir) run:

   Temporary serve — stays alive while the command runs, useful for testing:
       modal serve python-worker/modal_app.py

   Permanent deployment — survives restarts, gives a stable URL:
       modal deploy python-worker/modal_app.py

3. Copy the printed endpoint URL into backend/.env:
       PYTHON_WORKER_URL=https://<username>--virtual-cell-worker-web.modal.run
       PYTHON_WORKER_DRUGCLIP_TIMEOUT_MS=600000

Notes
-----
- The 1.1 GB model weights are downloaded once from HuggingFace on the first
  cold start and cached in a Modal Volume so subsequent starts skip the download.
- GPU: T4 by default.  Change gpu="T4" to gpu="A10G" for faster inference.
- Uncomment `keep_warm=1` to eliminate cold starts (~$0.50/hr cost on T4).
"""

import os
import modal

# ---------------------------------------------------------------------------
# Patch function — runs inside the container at IMAGE BUILD time
# ---------------------------------------------------------------------------

def _install_unicore():
    """
    Clone Uni-Core, replace its setup.py with a minimal Python-only version
    (no CUDA extension compilation), then pip-install and verify the import.
    The actual traceback is embedded in the RuntimeError so Modal surfaces it
    in the terminal output if the import fails.
    """
    import subprocess
    import sys

    # ── 1. Clone ──────────────────────────────────────────────────────────────
    subprocess.run(
        ["git", "clone", "-q", "https://github.com/dptech-corp/Uni-Core.git", "/tmp/uni-core"],
        check=True,
    )

    # ── 2. Replace build files — drop all CUDA/C extensions ──────────────────
    import os
    minimal_setup = (
        "from setuptools import setup, find_packages\n"
        "setup(\n"
        "    name='unicore',\n"
        "    version='0.0.1',\n"
        "    packages=find_packages(exclude=['tests*', 'examples*']),\n"
        "    install_requires=[],\n"
        ")\n"
    )
    with open("/tmp/uni-core/setup.py", "w") as fh:
        fh.write(minimal_setup)
    # Remove pyproject.toml / setup.cfg — they override setup.py and pull in
    # build requirements (setuptools_scm, etc.) that can break the install.
    for extra in ("pyproject.toml", "setup.cfg"):
        path = f"/tmp/uni-core/{extra}"
        if os.path.exists(path):
            os.remove(path)
            print(f"Removed {extra}")
    print("Replaced setup.py with Python-only version")

    # ── 3. Install — capture full output so errors appear in Modal terminal ───
    res = subprocess.run(
        [sys.executable, "-m", "pip", "install", "/tmp/uni-core"],
        capture_output=True, text=True,
    )
    print("pip stdout:", res.stdout[-2000:])
    if res.returncode != 0:
        raise RuntimeError(
            f"pip install unicore failed (exit {res.returncode}):\n"
            f"STDOUT:\n{res.stdout[-1500:]}\nSTDERR:\n{res.stderr[-1500:]}"
        )

    # ── 4. Verify import — embed full traceback in error so Modal shows it ────
    result = subprocess.run(
        [sys.executable, "-c",
         "import unicore; print('unicore OK:', unicore.__file__)"],
        capture_output=True, text=True,
    )
    print("import test stdout:", result.stdout)
    if result.returncode != 0:
        raise RuntimeError(
            f"unicore import failed after install:\n{result.stderr[-2000:]}"
        )
    print("Uni-Core installed (Python-only, no CUDA extensions)")


def _patch_drugclip():
    """Apply source-level patches to the freshly cloned DrugCLIP repository."""

    # Patch 1: tasks/drugclip.py
    # The original file has a bare top-level `from IPython import …` which
    # raises ImportError outside of Jupyter.  Wrap it in try/except.
    path = "/app/DrugCLIP/unimol/tasks/drugclip.py"
    src = open(path).read()
    old = "from IPython import embed as debug_embedded"
    new = (
        "try:\n"
        "    from IPython import embed as debug_embedded\n"
        "except ImportError:\n"
        "    debug_embedded = lambda: None"
    )
    if old in src and "try:" not in src[:200]:
        open(path, "w").write(src.replace(old, new))
        print("Patched tasks/drugclip.py (IPython import)")
    else:
        print("tasks/drugclip.py: no patch needed")

    # Patch 2: models/drugclip.py
    # logit_scale is initialised with device="cuda" hardcoded; replace with a
    # runtime check so the model can also load on CPU if CUDA is unavailable.
    path = "/app/DrugCLIP/unimol/models/drugclip.py"
    src = open(path).read()
    old = 'self.logit_scale = nn.Parameter(torch.ones([1], device="cuda") * np.log(14))'
    new = (
        '_logit_device = "cuda" if torch.cuda.is_available() else "cpu"\n'
        "        self.logit_scale = nn.Parameter("
        "torch.ones([1], device=_logit_device) * np.log(14))"
    )
    if old in src:
        open(path, "w").write(src.replace(old, new))
        print("Patched models/drugclip.py (logit_scale device)")
    elif "_logit_device" in src:
        print("models/drugclip.py: already patched")
    else:
        print("WARNING: logit_scale line not found — check models/drugclip.py manually")


# ---------------------------------------------------------------------------
# Container image
# ---------------------------------------------------------------------------

_worker_dir = os.path.dirname(os.path.abspath(__file__))

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("git", "build-essential", "ninja-build", "libxrender1", "libxext6", "libgl1-mesa-glx", "libglib2.0-0")
    # PyTorch built for CUDA 12.1
    .pip_install(
        "torch==2.1.2",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    # Application-level Python dependencies
    .pip_install(
        "fastapi==0.135.2",
        "pydantic==2.12.5",
        "uvicorn[standard]",
        "pandas",
        "numpy<2",
        "scipy",
        "scikit-learn",
        "rdkit-pypi==2022.9.5",
        "lmdb",
        "tqdm",
        "huggingface_hub",
        "tokenizers",
    )
    # Uni-Core backbone — install with CUDA extension fallback logic
    .run_function(_install_unicore)
    # Clone DrugCLIP repo to /app/DrugCLIP — the path drugclip_inference.py
    # expects via:  os.path.join(os.path.dirname(__file__), "DrugCLIP")
    .run_commands("git clone https://github.com/bowen-gao/DrugCLIP.git /app/DrugCLIP")
    # Apply source patches in-container
    .run_function(_patch_drugclip)
    .workdir("/app")
    # Embed local worker source files directly into the image.
    # Modal detects content changes and rebuilds only this layer.
    .add_local_file(os.path.join(_worker_dir, "main.py"), "/app/main.py")
    .add_local_file(os.path.join(_worker_dir, "drugclip_inference.py"), "/app/drugclip_inference.py")
    .add_local_file(os.path.join(_worker_dir, "SMILES.csv"), "/app/SMILES.csv")
)

# ---------------------------------------------------------------------------
# Persistent volume — caches the 1.1 GB model checkpoint across cold starts
# The volume is mounted directly at the path drugclip_inference.py writes to:
#   /app/DrugCLIP/weights/pretrain_weights/drugclip.pt
# ---------------------------------------------------------------------------

weights_volume = modal.Volume.from_name("drugclip-weights", create_if_missing=True)
_WEIGHTS_DIR = "/app/DrugCLIP/weights/pretrain_weights"

# ---------------------------------------------------------------------------
# Modal App
# ---------------------------------------------------------------------------

app = modal.App("virtual-cell-worker")

# ---------------------------------------------------------------------------
# ASGI web endpoint
# ---------------------------------------------------------------------------

@app.function(
    image=image,
    gpu="T4",
    volumes={_WEIGHTS_DIR: weights_volume},
    timeout=1800,
    scaledown_window=600,
    min_containers=1,
)
@modal.asgi_app()
def web():
    """Serve the FastAPI app as a Modal ASGI web endpoint."""
    import sys
    import os
    import random
    import logging

    sys.path.insert(0, "/app")
    logging.basicConfig(level=logging.INFO)
    log = logging.getLogger("modal.startup")

    # ── Check model weights are present in the Volume ────────────────────────────────
    ckpt = os.path.join(_WEIGHTS_DIR, "drugclip.pt")
    if not os.path.isfile(ckpt):
        raise RuntimeError(
            f"DrugCLIP weights not found at {ckpt}.\n"
            "Upload them first:\n"
            "  modal volume put drugclip-weights /path/to/drugclip.pt /drugclip.pt"
        )
    log.info("Model weights found in Modal Volume.")

    import main as worker_main
    return worker_main.app
