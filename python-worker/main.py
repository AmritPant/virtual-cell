import hashlib
import random
import logging
import os
import sys
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load SMILES data once when server starts
print("Loading SMILES database...")
smiles_df = pd.read_csv('SMILES.csv')
smiles_data = smiles_df[['ID', 'SMILES']].to_dict('records')
print(f"Loaded {len(smiles_data)} molecules from SMILES.csv")

# ── DrugCLIP model (lazy-loaded on first request) ───────────────────────────
_DRUGCLIP_AVAILABLE = False
try:
    from drugclip_inference import score_molecules, _load_model, DEVICE as DRUGCLIP_DEVICE
    _DRUGCLIP_AVAILABLE = True
    logger.info("DrugCLIP inference module available.")
except Exception as e:
    DRUGCLIP_DEVICE = None
    logger.warning("DrugCLIP inference not available: %s. Using simulated scoring.", e)

USE_REAL_DRUGCLIP = os.environ.get("USE_REAL_DRUGCLIP", "1") == "1" and _DRUGCLIP_AVAILABLE

app = FastAPI(title="virtual-cell-worker")


class FastFoldRequest(BaseModel):
    uniprotId: str


class FpocketRequest(BaseModel):
    structureFileId: str | None = None


class DrugClipRequest(BaseModel):
    pockets: list = []
    molecules: list = []
    pdb_content: str | None = None


class DiscoverRequest(BaseModel):
    pdb_content: str
    protein_id: str


class VinaRequest(BaseModel):
    smiles: str
    sessionId: str


@app.get("/health")
def health():
    return {"status": "ok", "drugclip": USE_REAL_DRUGCLIP, "device": str(DRUGCLIP_DEVICE) if DRUGCLIP_DEVICE else "none"}


@app.post("/preload")
def preload():
    """Pre-load the DrugCLIP model so first inference is fast."""
    if not USE_REAL_DRUGCLIP:
        return {"status": "skipped", "reason": "DrugCLIP not available"}
    try:
        _load_model()
        return {"status": "loaded"}
    except Exception as e:
        return {"status": "error", "reason": str(e)}


@app.post("/fast-fold")
def fast_fold(payload: FastFoldRequest):
    # Stub for local/dev. Replace with real accelerated folding pipeline.
    return {"uniprotId": payload.uniprotId, "structureFileId": f"fastfold-{payload.uniprotId}"}


@app.post("/fpocket")
def fpocket(payload: FpocketRequest):
    # Stub pockets; replace with true fpocket coordinates extraction.
    return {
        "structureFileId": payload.structureFileId,
        "pockets": [
            {"id": "p1", "position": [0.8, 0.2, 0.4]},
            {"id": "p2", "position": [-0.5, -0.2, 0.9]},
            {"id": "p3", "position": [0.1, 0.7, -0.7]},
        ],
    }


@app.post("/drugclip")
def drugclip(payload: DrugClipRequest):
    """
    DrugCLIP model inference – scores molecules against protein pockets.
    Uses real DrugCLIP when available, falls back to simulated scoring.
    """
    # ── Collect SMILES to score ──
    smiles_list = []
    id_map = {}  # smi → id
    if payload.molecules:
        for i, item in enumerate(payload.molecules[:200]):
            if isinstance(item, dict) and 'SMILES' in item:
                smi, mid = item['SMILES'], item['ID']
            else:
                smi = item.get("smiles", "")
                mid = item.get("id", f"mol_{i}")
            if smi:
                smiles_list.append(smi)
                id_map[smi] = mid
    else:
        sample = random.sample(smiles_data, min(200, len(smiles_data)))
        for item in sample:
            smiles_list.append(item['SMILES'])
            id_map[item['SMILES']] = item['ID']

    # ── Real DrugCLIP scoring ──
    if USE_REAL_DRUGCLIP and payload.pdb_content:
        try:
            logger.info("Running real DrugCLIP on %d molecules…", len(smiles_list))
            results = score_molecules(
                smiles_list, payload.pdb_content,
                pocket_id="pocket", top_k=100,
            )
            ranked = []
            for r in results:
                ranked.append({
                    "id": id_map.get(r["smi"], r["smi"][:12]),
                    "smiles": r["smi"],
                    "score": round(r["score"], 4),
                    "dockingData": None,
                })
            return {"results": ranked}
        except Exception as e:
            logger.error("DrugCLIP inference failed, falling back: %s", e)

    # ── Fallback: simulated scoring ──
    pocket_hash = hashlib.md5(
        str(sorted([p.get('id', '') + str(p.get('position', [])) for p in payload.pockets])).encode()
    ).hexdigest()
    random.seed(int(pocket_hash[:8], 16))
    ranked = []
    for smi in smiles_list[:100]:
        mol_hash = hashlib.md5((pocket_hash + smi).encode()).hexdigest()
        mol_seed = int(mol_hash[:8], 16)
        base_score = -9.0 + (mol_seed % 60) * 0.1
        pocket_modifier = (mol_seed % 40) * 0.075
        final_score = max(-12.0, min(-6.0, round(base_score - pocket_modifier, 3)))
        ranked.append({
            "id": id_map.get(smi, smi[:12]),
            "smiles": smi,
            "score": final_score,
            "dockingData": None,
        })
    ranked.sort(key=lambda x: x["score"])
    return {"results": ranked}


@app.post("/discover")
def discover(payload: DiscoverRequest):
    """
    Complete discovery pipeline.
    Uses real DrugCLIP when available, otherwise simulated scoring.
    """
    protein_hash = hashlib.md5((payload.protein_id + str(payload.pdb_content)[:200]).encode()).hexdigest()
    protein_seed = int(protein_hash[:8], 16)
    random.seed(protein_seed)
    selected_molecules = random.sample(smiles_data, min(300, len(smiles_data)))

    # Generate pockets (used by frontend)
    random.seed(protein_seed + 1)
    pockets = []
    for i in range(3):
        pockets.append({
            "id": f"p{i+1}",
            "position": [
                round(random.uniform(-1, 1), 2),
                round(random.uniform(-1, 1), 2),
                round(random.uniform(-1, 1), 2),
            ],
        })

    smiles_list = [m['SMILES'] for m in selected_molecules]
    id_map = {m['SMILES']: m['ID'] for m in selected_molecules}

    # ── Real DrugCLIP scoring ──
    if USE_REAL_DRUGCLIP and payload.pdb_content:
        try:
            logger.info("Running real DrugCLIP discover on %d molecules…", len(smiles_list))
            results = score_molecules(
                smiles_list, payload.pdb_content,
                pocket_id=payload.protein_id, top_k=100,
            )
            top_hits = []
            for r in results:
                top_hits.append({
                    "id": id_map.get(r["smi"], r["smi"][:12]),
                    "smiles": r["smi"],
                    "score": round(r["score"], 4),
                })
            return {
                "protein_id": payload.protein_id,
                "top_hits": top_hits,
                "pockets": pockets,
                "total_molecules": len(selected_molecules),
            }
        except Exception as e:
            logger.error("DrugCLIP discover failed, falling back: %s", e)

    # ── Fallback: simulated scoring ──
    top_hits = []
    for smi in smiles_list:
        mol_hash = hashlib.md5((protein_hash + smi).encode()).hexdigest()
        mol_seed = int(mol_hash[:8], 16)
        base_score = -9.0 + (mol_seed % 60) * 0.1
        pocket_modifier = (mol_seed % 40) * 0.075
        final_score = max(-12.0, min(-6.0, round(base_score - pocket_modifier, 3)))
        top_hits.append({"id": id_map.get(smi, smi[:12]), "smiles": smi, "score": final_score})
    top_hits.sort(key=lambda x: x["score"])
    return {
        "protein_id": payload.protein_id,
        "top_hits": top_hits[:100],
        "pockets": pockets,
        "total_molecules": len(selected_molecules),
    }


@app.post("/vina")
def vina(payload: VinaRequest):
    return {
        "smiles": payload.smiles,
        "sessionId": payload.sessionId,
        "bindingEnergy": -9.84,
        "poses": 9,
    }
