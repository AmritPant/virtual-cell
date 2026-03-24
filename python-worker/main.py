import hashlib
import random
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel

# Load SMILES data once when server starts
print("Loading SMILES database...")
smiles_df = pd.read_csv('SMILES.csv')
smiles_data = smiles_df[['ID', 'SMILES']].to_dict('records')
print(f"Loaded {len(smiles_data)} molecules from SMILES.csv")

app = FastAPI(title="virtual-cell-worker")


class FastFoldRequest(BaseModel):
    uniprotId: str


class FpocketRequest(BaseModel):
    structureFileId: str | None = None


class DrugClipRequest(BaseModel):
    pockets: list = []
    molecules: list = []


class DiscoverRequest(BaseModel):
    pdb_content: str
    protein_id: str


class VinaRequest(BaseModel):
    smiles: str
    sessionId: str


@app.get("/health")
def health():
    return {"status": "ok"}


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
    Simulate DrugCLIP model inference using local SMILES database.
    Generates protein-specific scores based on pockets and molecule combinations.
    """
    ranked = []
    
    # Create a deterministic seed based on protein pockets for consistency
    pocket_hash = hashlib.md5(
        str(sorted([p.get('id', '') + str(p.get('position', [])) for p in payload.pockets])).encode()
    ).hexdigest()
    
    # Use the hash as a seed for reproducible but protein-specific randomization
    random.seed(int(pocket_hash[:8], 16))
    
    # Get molecules from payload or use local database
    molecules_to_process = payload.molecules if payload.molecules else random.sample(smiles_data, min(100, len(smiles_data)))
    
    for i, item in enumerate(molecules_to_process[:100]):
        # Handle both local database format and input format
        if isinstance(item, dict) and 'SMILES' in item:
            smiles = item['SMILES']
            molecule_id = item['ID']
        else:
            smiles = item.get("smiles", "")
            molecule_id = item.get("id", f"mol_{i}")
            
        if not smiles:
            continue
            
        # Generate molecule-specific hash for consistent scoring per molecule
        mol_hash = hashlib.md5((pocket_hash + smiles).encode()).hexdigest()
        mol_seed = int(mol_hash[:8], 16)
        
        # Use molecule-specific seed for score generation
        random.seed(mol_seed)
        
        # Simulate DrugCLIP scoring with protein-molecule interaction
        # Base score ranges from -12 to -6, with protein-specific variations
        base_score = -9.0 + (mol_seed % 60) * 0.1  # Range: -9.0 to -3.0
        pocket_modifier = (mol_seed % 40) * 0.075     # Range: 0 to 3.0
        final_score = round(base_score - pocket_modifier, 3)  # Range: -12.0 to -6.0
        
        # Ensure score is within realistic binding affinity range
        final_score = max(-12.000, min(-6.000, final_score))
        
        ranked.append({
            "id": molecule_id,
            "smiles": smiles, 
            "score": final_score, 
            "dockingData": None
        })
    
    # Sort by score (best scores first - more negative is better)
    ranked.sort(key=lambda x: x["score"])
    
    return {"results": ranked}


@app.post("/discover")
def discover(payload: DiscoverRequest):
    """
    Complete discovery pipeline using local SMILES database.
    Returns protein-specific rankings based on local molecule library.
    """
    # Generate protein-specific seed from protein_id and PDB content
    protein_hash = hashlib.md5((payload.protein_id + str(payload.pdb_content)[:200]).encode()).hexdigest()
    protein_seed = int(protein_hash[:8], 16)
    
    # Select a subset of molecules from local database (300 molecules)
    random.seed(protein_seed)
    selected_molecules = random.sample(smiles_data, min(300, len(smiles_data)))
    
    # Generate protein-specific pockets for scoring consistency
    pockets = []
    for i in range(3):
        pockets.append({
            "id": f"p{i+1}",
            "position": [
                round(random.uniform(-1, 1), 2),
                round(random.uniform(-1, 1), 2), 
                round(random.uniform(-1, 1), 2)
            ]
        })
    
    # Score each molecule with protein-specific binding simulation
    top_hits = []
    for i, molecule in enumerate(selected_molecules):
        smiles = molecule['SMILES']
        molecule_id = molecule['ID']
        
        # Create molecule-specific seed for consistent but protein-specific scoring
        mol_hash = hashlib.md5((protein_hash + smiles).encode()).hexdigest()
        mol_seed = int(mol_hash[:8], 16)
        random.seed(mol_seed)
        
        # Simulate binding affinity score (realistic range: -12.000 to -6.000)
        # More negative = better binding affinity
        base_score = -9.0 + (mol_seed % 60) * 0.1  # Range: -9.0 to -3.0
        pocket_modifier = (mol_seed % 40) * 0.075     # Range: 0 to 3.0
        final_score = round(base_score - pocket_modifier, 3)  # Range: -12.0 to -6.0
        
        # Ensure score is within realistic binding affinity range
        final_score = max(-12.000, min(-6.000, final_score))
        
        top_hits.append({
            "id": molecule_id,
            "smiles": smiles,
            "score": final_score
        })
    
    # Sort by score (best binding affinity first - more negative is better)
    top_hits.sort(key=lambda x: x["score"])
    
    # Return top 100 hits
    return {
        "protein_id": payload.protein_id,
        "top_hits": top_hits[:100],
        "pockets": pockets,
        "total_molecules": len(selected_molecules)
    }


@app.post("/vina")
def vina(payload: VinaRequest):
    return {
        "smiles": payload.smiles,
        "sessionId": payload.sessionId,
        "bindingEnergy": -9.84,
        "poses": 9,
    }
