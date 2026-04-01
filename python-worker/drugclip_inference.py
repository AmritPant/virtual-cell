"""
DrugCLIP inference wrapper.
Loads the pretrained DrugCLIP model (Uni-Mol backbone) and exposes helpers
to score a set of SMILES molecules against protein binding-pocket atoms.

Automatically uses the best available backend:
  Apple Silicon MPS (Metal GPU) → CUDA → CPU
"""

import os
import sys
import pickle
import tempfile
import logging
import argparse

import lmdb
import numpy as np
import torch
from tqdm import tqdm

# ── RDKit for 3-D conformer generation ──────────────────────────────────────
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

RDLogger.DisableLog("rdApp.*")

# ── Make the cloned DrugCLIP repo importable ─────────────────────────────────
_DRUGCLIP_ROOT = os.path.join(os.path.dirname(__file__), "DrugCLIP")
if _DRUGCLIP_ROOT not in sys.path:
    sys.path.insert(0, _DRUGCLIP_ROOT)

from unicore import checkpoint_utils
from unicore.data import Dictionary

logger = logging.getLogger(__name__)


# ── Device selection: MPS (Apple Silicon GPU) → CUDA → CPU ──────────────────
def _get_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _move_to_device(sample: dict, device: torch.device) -> dict:
    """Recursively move all tensors in a nested dict to *device*."""
    out = {}
    for k, v in sample.items():
        if isinstance(v, torch.Tensor):
            out[k] = v.to(device)
        elif isinstance(v, dict):
            out[k] = _move_to_device(v, device)
        else:
            out[k] = v
    return out


DEVICE = _get_device()
logger.info("DrugCLIP will use device: %s", DEVICE)

# ── Paths (relative to this file) ───────────────────────────────────────────
_DATA_DIR = os.path.join(_DRUGCLIP_ROOT, "data")
_WEIGHTS_DIR = os.path.join(_DRUGCLIP_ROOT, "weights", "pretrain_weights")
_CHECKPOINT_PATH = os.path.join(_WEIGHTS_DIR, "drugclip.pt")
_DICT_MOL = os.path.join(_DATA_DIR, "dict_mol.txt")
_DICT_PKT = os.path.join(_DATA_DIR, "dict_pkt.txt")
_EMB_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".emb_cache")


# ═══════════════════════════════════════════════════════════════════════════════
#  LMDB helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _write_lmdb(records: list[dict], path: str):
    """Write a list of dicts into an LMDB file keyed by sequential index."""
    env = lmdb.open(path, subdir=False, lock=False, readahead=False,
                    meminit=False, map_size=10 * 1024 * 1024 * 1024)
    with env.begin(write=True) as txn:
        for i, rec in enumerate(records):
            txn.put(str(i).encode("ascii"), pickle.dumps(rec))
    env.close()


# ═══════════════════════════════════════════════════════════════════════════════
#  SMILES → mol LMDB record
# ═══════════════════════════════════════════════════════════════════════════════

def _smiles_to_mol_record(smi: str, num_conf: int = 1) -> dict | None:
    """Convert a SMILES string to the dict format DrugCLIP expects."""
    mol = Chem.MolFromSmiles(smi)
    if mol is None:
        return None
    if mol.GetNumHeavyAtoms() > 50:
        return None
    try:
        mol = Chem.AddHs(mol)
        params = AllChem.ETKDG()
        params.maxAttempts = 50
        params.numThreads = 1
        ok = AllChem.EmbedMolecule(mol, params)
        if ok == -1:
            params.useRandomCoords = True
            AllChem.EmbedMolecule(mol, params)
        mol = Chem.RemoveHs(mol)
    except Exception:
        return None

    if mol.GetNumConformers() == 0:
        return None

    coords = [
        np.array(mol.GetConformer(i).GetPositions(), dtype=np.float32)
        for i in range(mol.GetNumConformers())
    ]
    atoms = [a.GetSymbol() for a in mol.GetAtoms()]
    return {"atoms": atoms, "coordinates": coords, "smi": smi}


# ═══════════════════════════════════════════════════════════════════════════════
#  PDB pocket → pocket LMDB record
# ═══════════════════════════════════════════════════════════════════════════════

def _pdb_to_pocket_records(pdb_text: str, pocket_id: str = "pocket",
                           dist_threshold: float = 10.0) -> list[dict]:
    """
    Parse PDB text and extract pocket atoms.
    If HETATM ligand atoms are present the pocket is defined as protein atoms
    within *dist_threshold* Å of any ligand heavy atom.  Otherwise all ATOM
    records are used (capped at 256 atoms nearest the centroid).
    """
    atom_lines = []
    hetatm_lines = []
    for line in pdb_text.splitlines():
        if line.startswith("ATOM"):
            atom_lines.append(line)
        elif line.startswith("HETATM"):
            res = line[17:20].strip()
            if res not in ("HOH", "WAT"):
                hetatm_lines.append(line)

    def _parse_coords(line):
        return np.array([float(line[30:38]), float(line[38:46]), float(line[46:54])],
                        dtype=np.float32)

    def _parse_atom_name(line):
        name = line[12:16].strip()
        if name and name[0].isdigit():
            return name[1] if len(name) > 1 else name[0]
        return name[0]

    protein_coords = np.array([_parse_coords(l) for l in atom_lines], dtype=np.float32)
    protein_atoms = [_parse_atom_name(l) for l in atom_lines]

    if len(protein_coords) == 0:
        return []

    if hetatm_lines:
        lig_coords = np.array([_parse_coords(l) for l in hetatm_lines], dtype=np.float32)
        # find protein atoms within dist_threshold of any ligand atom
        from scipy.spatial.distance import cdist
        dists = cdist(protein_coords, lig_coords)
        mask = dists.min(axis=1) < dist_threshold
        pocket_coords = protein_coords[mask]
        pocket_atoms_list = [a for a, m in zip(protein_atoms, mask) if m]
    else:
        # no ligand – use all atoms, cap at 256 nearest centroid
        centroid = protein_coords.mean(axis=0)
        dists_to_center = np.linalg.norm(protein_coords - centroid, axis=1)
        order = np.argsort(dists_to_center)[:256]
        pocket_coords = protein_coords[order]
        pocket_atoms_list = [protein_atoms[i] for i in order]

    if len(pocket_coords) == 0:
        return []

    return [{
        "pocket_atoms": pocket_atoms_list,
        "pocket_coordinates": pocket_coords.astype(np.float32),
        "pocket": pocket_id,
    }]


# ═══════════════════════════════════════════════════════════════════════════════
#  Model loader (singleton)
# ═══════════════════════════════════════════════════════════════════════════════

_MODEL = None
_TASK = None


def _build_args():
    """Construct the minimal argparse.Namespace DrugCLIP/Uni-Mol needs."""
    ns = argparse.Namespace()
    ns.data = _DATA_DIR
    ns.seed = 1
    ns.max_seq_len = 512
    ns.task = "drugclip"
    ns.loss = "in_batch_softmax"
    ns.arch = "drugclip"
    ns.max_pocket_atoms = 256
    ns.fp16 = False
    ns.fp16_init_scale = 4
    ns.fp16_scale_window = 256
    ns.cpu = (DEVICE.type == "cpu")
    ns.device_id = 0
    ns.path = _CHECKPOINT_PATH
    ns.finetune_mol_model = None
    ns.finetune_pocket_model = None
    ns.dist_threshold = 6.0
    ns.test_model = False
    ns.reg = False
    ns.batch_size = 8
    # encoder config defaults (will be overridden by architecture fn)
    ns.mol_encoder_layers = 15
    ns.mol_encoder_embed_dim = 512
    ns.mol_encoder_ffn_embed_dim = 2048
    ns.mol_encoder_attention_heads = 64
    ns.pocket_encoder_layers = 15
    ns.pocket_encoder_embed_dim = 512
    ns.pocket_encoder_ffn_embed_dim = 2048
    ns.pocket_encoder_attention_heads = 64
    return ns


def _load_model():
    """Load the DrugCLIP model once (singleton). Uses best available device."""
    global _MODEL, _TASK

    if _MODEL is not None:
        return _MODEL, _TASK

    if not os.path.isfile(_CHECKPOINT_PATH):
        raise FileNotFoundError(f"Checkpoint not found at {_CHECKPOINT_PATH}")

    logger.info("Loading DrugCLIP model from %s …", _CHECKPOINT_PATH)

    # ── import & register the task + model inside DrugCLIP ──
    import unimol.tasks.drugclip  # noqa – registers @register_task("drugclip")
    import unimol.models.drugclip  # noqa – registers @register_model("drugclip")
    from unicore import tasks as unicore_tasks

    args = _build_args()
    task = unicore_tasks.setup_task(args)
    model = task.build_model(args)

    # load checkpoint weights
    state = checkpoint_utils.load_checkpoint_to_cpu(_CHECKPOINT_PATH)
    model.load_state_dict(state["model"], strict=False)
    model.eval()
    model.to(DEVICE)

    _MODEL = model
    _TASK = task
    logger.info("DrugCLIP model loaded on %s.", DEVICE)
    return model, task


# ═══════════════════════════════════════════════════════════════════════════════
#  Encoding helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _encode_mols(model, task, mol_lmdb_path: str, batch_size: int = 16):
    """Encode molecules → (N, 128) normalised embeddings + names list."""
    mol_dataset = task.load_retrieval_mols_dataset(mol_lmdb_path, "atoms", "coordinates")
    loader = torch.utils.data.DataLoader(
        mol_dataset, batch_size=batch_size, collate_fn=mol_dataset.collater,
    )
    all_embs, all_names = [], []
    for sample in tqdm(loader, desc="Encoding molecules", leave=False):
        sample = _move_to_device(sample, DEVICE)
        dist = sample["net_input"]["mol_src_distance"]
        et = sample["net_input"]["mol_src_edge_type"]
        st = sample["net_input"]["mol_src_tokens"]
        mask = st.eq(model.mol_model.padding_idx)
        x = model.mol_model.embed_tokens(st)
        n = dist.size(-1)
        gbf = model.mol_model.gbf(dist, et)
        bias = model.mol_model.gbf_proj(gbf).permute(0, 3, 1, 2).contiguous().view(-1, n, n)
        out = model.mol_model.encoder(x, padding_mask=mask, attn_mask=bias)
        rep = out[0][:, 0, :]
        emb = model.mol_project(rep)
        emb = emb / emb.norm(dim=-1, keepdim=True)
        all_embs.append(emb.detach().cpu().numpy())
        all_names.extend(sample["smi_name"])
    return np.concatenate(all_embs, axis=0), all_names


def _encode_pockets(model, task, pocket_lmdb_path: str, batch_size: int = 16):
    """Encode pockets → (M, 128) normalised embeddings."""
    pocket_dataset = task.load_pockets_dataset(pocket_lmdb_path)
    loader = torch.utils.data.DataLoader(
        pocket_dataset, batch_size=batch_size, collate_fn=pocket_dataset.collater,
    )
    all_embs = []
    for sample in tqdm(loader, desc="Encoding pockets", leave=False):
        sample = _move_to_device(sample, DEVICE)
        dist = sample["net_input"]["pocket_src_distance"]
        et = sample["net_input"]["pocket_src_edge_type"]
        st = sample["net_input"]["pocket_src_tokens"]
        mask = st.eq(model.pocket_model.padding_idx)
        x = model.pocket_model.embed_tokens(st)
        n = dist.size(-1)
        gbf = model.pocket_model.gbf(dist, et)
        bias = model.pocket_model.gbf_proj(gbf).permute(0, 3, 1, 2).contiguous().view(-1, n, n)
        out = model.pocket_model.encoder(x, padding_mask=mask, attn_mask=bias)
        rep = out[0][:, 0, :]
        emb = model.pocket_project(rep)
        emb = emb / emb.norm(dim=-1, keepdim=True)
        all_embs.append(emb.detach().cpu().numpy())
    return np.concatenate(all_embs, axis=0)


# ═══════════════════════════════════════════════════════════════════════════════
#  Public API
# ═══════════════════════════════════════════════════════════════════════════════

def score_molecules(
    smiles_list: list[str],
    pdb_text: str,
    pocket_id: str = "pocket",
    top_k: int = 100,
) -> list[dict]:
    """
    Score a list of SMILES against a protein pocket defined by PDB text.

    Returns a list of dicts sorted by score (descending):
        [{"smi": "CCO...", "score": 0.82}, ...]
    """
    model, task = _load_model()

    # ── Convert SMILES to LMDB (parallel) ──
    from concurrent.futures import ThreadPoolExecutor
    mol_records = []
    valid_indices = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(tqdm(
            pool.map(lambda s: _smiles_to_mol_record(s, 1), smiles_list),
            total=len(smiles_list), desc="Generating 3D conformers",
        ))
    for i, rec in enumerate(results):
        if rec is not None:
            mol_records.append(rec)
            valid_indices.append(i)

    if not mol_records:
        logger.warning("No valid molecules could be processed.")
        return []

    # ── Convert PDB to pocket LMDB ──
    pocket_records = _pdb_to_pocket_records(pdb_text, pocket_id)
    if not pocket_records:
        logger.warning("No pocket atoms extracted from PDB.")
        return []

    # ── Write temporary LMDB files ──
    tmpdir = tempfile.mkdtemp(prefix="drugclip_")
    mol_lmdb = os.path.join(tmpdir, "mols.lmdb")
    pocket_lmdb = os.path.join(tmpdir, "pocket.lmdb")
    _write_lmdb(mol_records, mol_lmdb)
    _write_lmdb(pocket_records, pocket_lmdb)

    # ── Encode & score ──
    with torch.no_grad():
        mol_embs, mol_names = _encode_mols(model, task, mol_lmdb)
        pocket_embs = _encode_pockets(model, task, pocket_lmdb)

    # cosine similarity (pocket_embs @ mol_embs.T) → max across pockets
    scores = (pocket_embs @ mol_embs.T).max(axis=0)

    # rank
    ranked_idx = np.argsort(scores)[::-1][:top_k]
    results = []
    for idx in ranked_idx:
        results.append({
            "smi": mol_names[idx],
            "score": float(scores[idx]),
        })

    # cleanup temp files
    try:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
    except Exception:
        pass

    return results
