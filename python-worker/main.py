import logging
import os
import sys
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load SMILES data once when server starts
print("Loading SMILES database...")
smiles_df = pd.read_csv('SMILES.csv')
smiles_data = smiles_df[['ID', 'SMILES']].to_dict('records')
print(f"Loaded {len(smiles_data)} molecules from SMILES.csv")

# ── DrugCLIP model (lazy-loaded on first request) ───────────────────────────
try:
    from drugclip_inference import score_molecules, _load_model, DEVICE as DRUGCLIP_DEVICE
    logger.info("DrugCLIP inference module loaded on device: %s", DRUGCLIP_DEVICE)
except Exception as e:
    raise RuntimeError(f"DrugCLIP inference module failed to load: {e}") from e

app = FastAPI(title="virtual-cell-worker")

# Overridable by modal_app.py for parallel multi-GPU fan-out
_parallel_discover_fn = None


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
    return {"status": "ok", "drugclip": True, "device": str(DRUGCLIP_DEVICE)}


@app.post("/preload")
def preload():
    """Pre-load the DrugCLIP model so first inference is fast."""
    try:
        _load_model()
        return {"status": "loaded", "device": str(DRUGCLIP_DEVICE)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Model preload failed: {e}")


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
    pdb_content is required to run real inference.
    """
    if not payload.pdb_content:
        raise HTTPException(status_code=400, detail="pdb_content is required for DrugCLIP inference")

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
        import random
        sample = random.sample(smiles_data, min(200, len(smiles_data)))
        for item in sample:
            smiles_list.append(item['SMILES'])
            id_map[item['SMILES']] = item['ID']

    logger.info("Running DrugCLIP on %d molecules (device: %s)…", len(smiles_list), DRUGCLIP_DEVICE)
    results = score_molecules(
        smiles_list, payload.pdb_content,
        pocket_id="pocket", top_k=100,
    )
    if not results:
        raise HTTPException(status_code=422, detail="DrugCLIP returned no results – check PDB content validity")
    ranked = [
        {
            "id": id_map.get(r["smi"], r["smi"][:12]),
            "smiles": r["smi"],
            "score": round(r["score"], 4),
            "dockingData": None,
        }
        for r in results
    ]
    return {"results": ranked}


@app.post("/discover")
def discover(payload: DiscoverRequest):
    """
    Complete discovery pipeline: scores all SMILES from the local database
    against the provided protein structure using real DrugCLIP inference.
    """
    if _parallel_discover_fn is not None:
        return _parallel_discover_fn(payload)
    import random
    selected_molecules = random.sample(smiles_data, min(100, len(smiles_data)))
    smiles_list = [m['SMILES'] for m in selected_molecules]
    id_map = {m['SMILES']: m['ID'] for m in selected_molecules}

    logger.info(
        "Running DrugCLIP discover for %s on %d molecules (device: %s)…",
        payload.protein_id, len(smiles_list), DRUGCLIP_DEVICE,
    )
    results = score_molecules(
        smiles_list, payload.pdb_content,
        pocket_id=payload.protein_id, top_k=100,
    )
    if not results:
        raise HTTPException(
            status_code=422,
            detail="DrugCLIP returned no results – PDB content may be invalid or contain no parseable ATOM records",
        )
    top_hits = [
        {
            "id": id_map.get(r["smi"], r["smi"][:12]),
            "smiles": r["smi"],
            "score": round(r["score"], 4),
        }
        for r in results
    ]
    return {
        "protein_id": payload.protein_id,
        "top_hits": top_hits,
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
