# Virtual Cell — Architecture & Technical Reference

This document explains every component of the Virtual Cell platform in depth: what each service does, how everything is wired together, and exactly what happens at each step when a user submits a protein for drug discovery.

---

## Table of Contents

1. [What the System Does](#1-what-the-system-does)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Complete Request Flow — Step by Step](#3-complete-request-flow--step-by-step)
4. [Frontend](#4-frontend)
5. [Backend](#5-backend)
6. [Python Worker on Modal](#6-python-worker-on-modal)
7. [DrugCLIP — How the Model Works](#7-drugclip--how-the-model-works)
8. [The Inference Pipeline in Detail](#8-the-inference-pipeline-in-detail)
9. [Modal Deployment Deep Dive](#9-modal-deployment-deep-dive)
10. [Model Weights](#10-model-weights)
11. [Molecule Database](#11-molecule-database)
12. [Environment Variables Reference](#12-environment-variables-reference)
13. [Key Files Reference](#13-key-files-reference)
14. [Local Development Setup](#14-local-development-setup)
15. [Deploying the Python Worker](#15-deploying-the-python-worker)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. What the System Does

Virtual Cell is an AI-assisted drug discovery platform. The user inputs a **UniProt protein ID** (e.g. `P05067` for the Alzheimer's amyloid precursor protein). The platform:

1. Downloads the protein's 3-D structure from the **AlphaFold EBI database** as a PDB file.
2. Sends that PDB to a cloud GPU running the **DrugCLIP** model.
3. DrugCLIP scores ~100 candidate small molecules from a curated SMILES library against the protein's binding pocket using **cosine similarity in a shared embedding space**.
4. The top-ranked molecules (scores between 0 and ~1) are returned and displayed in the dashboard.

Scores are **cosine similarities**, not docking energies. A score of `0.44` means the molecule's learned embedding is closely aligned with the protein pocket's embedding — the model has been trained to put good binders near each other in that space.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (React / Vite)                                             │
│  frontend/                                                          │
│  • DiscoveryDashboard.jsx  — user enters UniProt ID, sees results   │
│  • ProteinViewer.jsx       — Three.js 3-D protein visualisation     │
│  • SimulationTimeline.jsx  — live progress steps                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │  POST /api/discovery/discover
                             │  { uniprotId: "P05067" }
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Express API  (Node.js, port 4000)                                  │
│  backend/src/                                                       │
│  • discoveryController.js  — single handler, no DB, no queue        │
│  • alphafoldService.js     — fetches AlphaFold metadata + PDB text  │
│  • pythonWorkerService.js  — HTTP client to Modal endpoint          │
└────────────┬─────────────────────────────────────┬──────────────────┘
             │  GET /api/prediction/{uniprotId}      │  POST /discover
             ▼                                       ▼
┌────────────────────────┐          ┌────────────────────────────────┐
│  AlphaFold EBI API     │          │  Modal (cloud GPU — T4)        │
│  alphafold.ebi.ac.uk   │          │  python-worker/                │
│  Returns:              │          │  • main.py  (FastAPI app)      │
│  • pdbUrl              │          │  • drugclip_inference.py       │
│  • metadata            │          │    ├─ loads DrugCLIP model     │
└────────────────────────┘          │    ├─ encodes pocket           │
                                    │    ├─ encodes molecules        │
                                    │    └─ cosine similarity rank   │
                                    │  Returns: top_hits[]           │
                                    └────────────────────────────────┘
```

**Key design principle:** The backend is completely stateless. There is no database, no queue, and no caching layer. Every request goes end-to-end to Modal and returns fresh results.

---

## 3. Complete Request Flow — Step by Step

This traces a single click of "Start Discovery Cycle" for UniProt ID `P05067`.

### Step 1 — Frontend initiates request

`DiscoveryDashboard.jsx` calls:

```
POST http://localhost:4000/api/discovery/discover
Content-Type: application/json

{ "uniprotId": "P05067" }
```

The button is immediately set to "Running..." and disabled. The `SimulationTimeline` component advances to the `screening` step. The frontend waits synchronously for the response — there is no polling. The browser's `fetch()` has no timeout, and the backend passes a 30-minute timeout (`PYTHON_WORKER_DRUGCLIP_TIMEOUT_MS`) to axios, so the connection stays alive for the full inference duration.

### Step 2 — Backend: fetch AlphaFold metadata

`discoveryController.js` calls `fetchAlphaFoldModel(uniprotId)` in `alphafoldService.js`:

```
GET https://alphafold.ebi.ac.uk/api/prediction/P05067
```

AlphaFold returns a JSON array. The first element contains:
- `pdbUrl` — direct link to the `.pdb` file (e.g. `https://alphafold.ebi.ac.uk/files/AF-P05067-F1-model_v4.pdb`)
- `cifUrl` — CIF format alternative
- `uniprotId`, confidence scores, etc.

If the protein is not in the AlphaFold database, a `PROTEIN_NOT_FOUND` error (HTTP 404) is returned to the frontend.

### Step 3 — Backend: download PDB content

`fetchAlphaFoldPdbContent(model)` makes a second HTTP request to download the raw text of the `.pdb` file. This is a plain-text file containing `ATOM` records (one per protein atom) with 3-D coordinates. The content is typically 100–800 KB for human proteins.

This raw PDB text string is what gets passed to DrugCLIP — it does its own pocket extraction from this text.

### Step 4 — Backend: call Modal `/discover`

`pythonWorkerService.js` posts to Modal:

```
POST https://info-amritpant--virtual-cell-worker-web.modal.run/discover
Content-Type: application/json

{
  "pdb_content": "ATOM      1  N   MET A   1 ...\n...",
  "protein_id": "P05067"
}
```

Axios waits up to 30 minutes for a response.

### Step 5 — Modal: FastAPI handler receives request

`main.py`'s `/discover` endpoint receives the payload. It:
1. Randomly samples 100 molecules from the in-memory `smiles_data` list (loaded from `SMILES.csv` at startup).
2. Calls `score_molecules(smiles_list, pdb_content, pocket_id, top_k=100)` from `drugclip_inference.py`.

### Step 6 — Modal: 3-D conformer generation

For each of the 100 SMILES strings, `_smiles_to_mol_record()` uses **RDKit** to:
1. Parse the SMILES into a molecule graph (`Chem.MolFromSmiles`).
2. Reject molecules with more than 50 heavy atoms.
3. Add implicit hydrogens (`Chem.AddHs`).
4. Generate a 3-D conformer using the **ETKDG** algorithm (`AllChem.EmbedMolecule`). This places every atom at physically realistic 3-D coordinates.
5. Remove hydrogens again (`Chem.RemoveHs`).
6. Return `{ atoms: [...], coordinates: [[x,y,z], ...], smi: "..." }`.

Molecules that fail conformer generation are silently dropped.

### Step 7 — Modal: pocket extraction from PDB

`_pdb_to_pocket_records()` parses the raw PDB text:
- Reads all `ATOM` lines (protein backbone + side chains).
- Reads all `HETATM` lines that are not water (`HOH`/`WAT`) — these are co-crystallised ligand atoms.
- **If ligand atoms are present:** the pocket is defined as all protein atoms within **10 Å** of any ligand heavy atom (using scipy `cdist`). This gives a tight, biologically relevant binding site.
- **If no ligand atoms:** all protein atoms are used, capped at the **256 nearest to the centroid**. AlphaFold structures have no ligands, so this path is always taken for this project.

The output is a single pocket record: `{ pocket_atoms: [...], pocket_coordinates: ndarray, pocket: "P05067" }`.

### Step 8 — Modal: write temporary LMDB files

Both the molecule records and the pocket record are serialised with `pickle` into two temporary **LMDB** (Lightning Memory-Mapped Database) files on the container's local disk. LMDB is a key-value store that DrugCLIP's data loaders expect — it allows random-access reads during batched DataLoader iteration without loading everything into RAM at once.

### Step 9 — Modal: encode molecules with DrugCLIP

`_encode_mols()` runs the **molecule encoder** (a 15-layer Uni-Mol Transformer) over the molecule LMDB in batches of 8:

- **Tokenisation:** atom symbols are mapped to integer token IDs via `dict_mol.txt` (the molecule vocabulary dictionary).
- **Distance matrix:** pairwise 3-D distances between all atoms in a molecule are computed and encoded using a **Gaussian Basis Function (GBF)** kernel into a continuous feature vector per atom pair.
- **Edge types:** pairs of atom types are looked up in the edge-type dictionary to get discrete edge-type tokens.
- **Encoder:** the 15-layer Transformer processes the atom token sequence with the GBF-derived pairwise attention bias added on top of normal self-attention. This means every atom attends to every other atom weighted by their 3-D proximity.
- **[CLS] representation:** the output at position 0 (the `[CLS]` token) is taken as the molecule-level representation.
- **Projection:** a learned linear `mol_project` layer maps this to a 128-dimensional embedding, then **L2-normalised** to unit length.

Output: an `(N, 128)` float32 matrix where N ≤ 100.

### Step 10 — Modal: encode pocket with DrugCLIP

`_encode_pockets()` runs the **pocket encoder** (another independent 15-layer Uni-Mol Transformer) over the pocket LMDB:

- Same architecture as the molecule encoder but with its own separate weights (`pocket_model`, `pocket_project`).
- The pocket token vocabulary is `dict_pkt.txt` (residue/atom symbols for protein atoms).
- Input is the list of pocket atom symbols + their 3-D coordinates.
- Output: a `(1, 128)` L2-normalised embedding for the single pocket.

### Step 11 — Modal: cosine similarity scoring and ranking

```python
scores = (pocket_embs @ mol_embs.T).max(axis=0)
```

Because both embeddings are L2-normalised, the dot product equals the cosine similarity directly. The result is a vector of N scores, one per molecule. Scores range from roughly 0.2 to 0.5 for typical molecules against a real protein.

`np.argsort(scores)[::-1][:top_k]` selects the top 100 highest-scoring molecules.

### Step 12 — Response travels back

Modal returns:
```json
{
  "protein_id": "P05067",
  "top_hits": [
    { "id": "ZINC000001234", "smiles": "CCO...", "score": 0.4418 },
    ...
  ],
  "total_molecules": 100
}
```

The backend wraps this with the `pdbUrl` and returns it to the frontend:
```json
{
  "pdbUrl": "https://alphafold.ebi.ac.uk/files/AF-P05067-F1-model_v4.pdb",
  "top_hits": [ ... ]
}
```

### Step 13 — Frontend renders results

- `pdbUrl` is passed to `ProteinViewer.jsx` which loads the 3-D structure using `@react-three/fiber`.
- `top_hits` is stored in `results` state.
- For each result's SMILES string, `resolveCompoundNames()` in `smilesToName.js` queries the **PubChem PUG REST API** to resolve the SMILES to a human-readable compound name (e.g. `"CCO..."` → `"Ethanol"`). This is done in batches of 8 in the background and the table updates as names arrive.
- Scores are displayed as 3-decimal floats (e.g. `0.442`).

---

## 4. Frontend

**Location:** `frontend/`  
**Framework:** React 18 + Vite  
**Key dependencies:** `@react-three/fiber`, `@react-three/drei`, `lucide-react`

### `src/pages/DiscoveryDashboard.jsx`

The single page of the application. All state lives here:

| State variable | Type | Purpose |
|---|---|---|
| `uniprotId` | string | Input field value |
| `status` | string | Current pipeline step (`queued` / `folding` / `screening` / `completed`) |
| `statusLabel` | string | Human-readable label shown in timeline |
| `progress` | number | Percentage (0–100) for the active step's progress bar |
| `pdbUrl` | string | AlphaFold PDB URL returned by backend |
| `results` | array | `top_hits` array from backend |
| `compoundNames` | Map | SMILES → resolved compound name from PubChem |
| `isRunning` | boolean | True while the fetch is in-flight; disables the button |
| `error` | string | Error message shown below the input |

The `startSession()` function is the entry point. It validates the UniProt ID format with a regex (`/^[A-Za-z0-9_-]{2,20}$/`), then makes a single `fetch()` call to `POST /api/discovery/discover`. The entire inference pipeline executes server-side before the response arrives. There is no polling, no session ID, no intermediate state stored anywhere.

### `src/components/ProteinViewer.jsx`

Renders the 3-D protein structure using Three.js. Receives `pdbUrl` as a prop. When `pdbUrl` changes, fetches and parses the PDB file client-side to extract atom coordinates, then draws a stick/ribbon representation. Pockets are highlighted as coloured spheres.

### `src/components/SimulationTimeline.jsx`

A visual pipeline tracker with five steps: `queued → folding → pocket → screening → completed`. Each step shows an icon, label, and subtitle. The currently active step shows a progress bar driven by the `progress` prop. Steps before the current one show a "done" checkmark state.

### `src/utils/smilesToName.js`

Resolves SMILES strings to human-readable compound names via the **PubChem PUG REST API** (free, no API key):
1. `GET https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/{encoded_smiles}/cids/JSON` — get PubChem CID.
2. `GET https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{cid}/property/IUPACName,Title/JSON` — get the common name ("Title") or IUPAC name.

Results are cached in a module-level `Map` so the same SMILES is never fetched twice within a session. Unknown SMILES fall back to a structural hint (`"Aromatic Compound"`, `"Carboxylic Acid"`, etc.) derived by pattern-matching the SMILES string.

---

## 5. Backend

**Location:** `backend/`  
**Runtime:** Node.js (ESM modules)  
**Framework:** Express 4  
**Key dependencies:** `axios`, `dotenv`, `cors`, `express`

The backend is **completely stateless**. No database, no queue, no cache. It is a pure HTTP proxy + orchestrator.

### `src/index.js`

Entry point. Loads `.env` via `dotenv/config`, creates the Express server, and starts listening on port 4000. Nothing else — no database connection, no worker startup.

### `src/app.js`

Configures Express middleware:
- `cors()` — allows requests from the frontend dev server.
- `express.json({ limit: "5mb" })` — parses JSON bodies up to 5 MB (PDB files can be large).
- Mounts discovery routes at `/api/discovery`.
- Global error handler returns `500` with a plain JSON message.

### `src/routes/discoveryRoutes.js`

```
POST /api/discovery/discover  →  discoverMolecules
```

That's the only route.

### `src/controllers/discoveryController.js`

The single handler `discoverMolecules`:

1. Validates `uniprotId` is present.
2. Calls `fetchAlphaFoldModel(uniprotId)` — if the protein isn't found, returns HTTP 404 with a user-friendly message.
3. Calls `fetchAlphaFoldPdbContent(model)` — downloads the raw PDB text.
4. Calls `runDiscover({ pdb_content, protein_id })` — POSTs to Modal, waits up to 30 minutes.
5. Returns `{ pdbUrl, top_hits }`.

Error codes propagate from the service layer: `PROTEIN_NOT_FOUND` → 404, `ALPHAFOLD_TIMEOUT` → 408, `SERVICE_UNAVAILABLE` → 503.

### `src/services/alphafoldService.js`

Three exported functions:

- `fetchAlphaFoldModel(uniprotId)` — GETs `https://alphafold.ebi.ac.uk/api/prediction/{id}`, returns the first result object (contains `pdbUrl`, `cifUrl`, version info). Throws typed errors for 404/timeout/connection refusal.
- `persistAlphaFoldStructure(model, uniprotId)` — *not currently used in the active flow* (legacy from the old queue architecture). Streams the PDB file to MongoDB GridFS.
- `fetchAlphaFoldPdbContent(model)` — downloads the raw PDB text string from `model.pdbUrl`.

### `src/services/pythonWorkerService.js`

HTTP client that wraps all Modal API calls. Reads `PYTHON_WORKER_URL` from env, normalises it (adds `https://` if scheme is missing). Two timeout values:
- `requestTimeoutMs` (default 15 s) — used for quick calls like `/fpocket`.
- `drugclipTimeoutMs` (default 30 min) — used for `/discover` and `/drugclip`.

The active export used by the controller is:
```js
export async function runDiscover({ pdb_content, protein_id }) {
  return postToWorker("/discover", { pdb_content, protein_id }, drugclipTimeoutMs);
}
```

---

## 6. Python Worker on Modal

**Location:** `python-worker/`  
**Runtime:** Python 3.11 inside a Modal-managed container  
**Framework:** FastAPI + Uvicorn  
**GPU:** NVIDIA T4 (16 GB VRAM)

The worker is deployed as a **Modal ASGI web endpoint**. Modal handles container lifecycle, GPU provisioning, auto-scaling, and HTTPS.

### `main.py` — FastAPI application

Loaded once per container start. At startup:

1. Reads `SMILES.csv` into a Pandas DataFrame and converts it to a plain list of `{ ID, SMILES }` dicts stored as `smiles_data`. This stays in memory for the lifetime of the container.
2. Imports `drugclip_inference.py` — this triggers device detection (`CUDA` on Modal) and sets up the module but does **not** yet load model weights (that happens lazily on the first request).

#### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Returns `{ status, drugclip, device }`. Good for checking if the container is warm. |
| POST | `/preload` | Explicitly loads the DrugCLIP model weights. Call this to "warm up" the container before a real request. |
| POST | `/fast-fold` | Stub — returns a fake `structureFileId`. Replace with real folding if needed. |
| POST | `/fpocket` | Stub — returns 3 hardcoded pocket positions. Replace with real fpocket binary output if needed. |
| POST | `/drugclip` | Scores a user-supplied molecule list against `pdb_content`. Used for custom molecule sets. |
| POST | `/discover` | **Main endpoint.** Samples 100 molecules from `SMILES.csv`, runs full DrugCLIP inference, returns `top_hits`. |
| POST | `/vina` | Stub — returns a hardcoded docking energy. AutoDock Vina integration not yet implemented. |

### `drugclip_inference.py` — Inference engine

This is the core of the ML pipeline. See [Section 8](#8-the-inference-pipeline-in-detail) for a line-by-line walkthrough.

---

## 7. DrugCLIP — How the Model Works

DrugCLIP is a **CLIP-style contrastive learning model** for drug-protein interaction. CLIP (Contrastive Language–Image Pre-training) was originally designed to align image and text embeddings; DrugCLIP applies the same idea to **small molecules and protein binding pockets**.

### Architecture

The model has two independent encoders:

```
Small molecule (SMILES + 3-D conformer)
        │
        ▼
  Molecule Encoder                Pocket Encoder
  (Uni-Mol, 15 layers,            (Uni-Mol, 15 layers,
   512-dim, 64 heads)              512-dim, 64 heads)
        │                                  │
        ▼                                  ▼
  mol_project (linear)           pocket_project (linear)
        │                                  │
        ▼                                  ▼
   128-dim L2-norm              128-dim L2-norm embedding
   embedding                             │
        │                                │
        └──── cosine similarity ──────────┘
                     │
                     ▼
              binding score (0 → ~1)
```

Both encoders use the **Uni-Mol** backbone — a Transformer that is specifically designed for 3-D molecular data. Unlike a standard Transformer that adds positional encodings for sequence positions, Uni-Mol adds **pairwise 3-D distance information** directly into the attention mechanism via Gaussian Basis Functions (GBF).

### Training (original paper)

DrugCLIP was trained on millions of protein–ligand pairs from the PDB and other databases. For each positive (protein, ligand) pair in a training batch, the model is trained to maximise cosine similarity. For all other (protein, different-ligand) combinations within the same batch, it is trained to minimise similarity. This is the **in-batch softmax contrastive loss** (also called InfoNCE loss).

After training, the model has learned a shared 128-dimensional embedding space where:
- A protein pocket embedding is geometrically close to embeddings of molecules that bind to it.
- Molecules with similar pharmacophores cluster together.
- Pockets with similar shapes cluster together.

At inference time, no explicit docking (no force field, no energy minimisation) is needed. The score is purely the cosine similarity in learned embedding space.

### What scores mean

| Score range | Interpretation |
|---|---|
| 0.40 – 0.50 | Strong predicted binder — model is highly confident |
| 0.25 – 0.40 | Moderate predicted binder — worth experimental follow-up |
| 0.10 – 0.25 | Weak / unlikely binder |
| < 0.10 | Not predicted to bind |

Scores **cannot** be negative in the current implementation (cosine similarity of L2-normalised vectors is bounded to [−1, 1] but in practice always positive for chemically reasonable molecules). **If you see −10.5 scores, the model is running old broken code — see [Troubleshooting](#16-troubleshooting).**

### Uni-Mol backbone detail

The attention score between atom i and atom j in a Uni-Mol layer is:

```
Attention(i, j) = softmax( (Q_i · K_j) / √d_k  +  GBF(dist_ij) · W_pair )
```

Where `GBF(dist_ij)` is a bank of Gaussian basis functions evaluated at the Euclidean distance between atoms i and j, then projected to a scalar bias via a learned matrix `W_pair`. This makes the Transformer inherently aware of molecular geometry.

---

## 8. The Inference Pipeline in Detail

This section traces `score_molecules()` in `drugclip_inference.py` line by line.

### 8.1 Model loading (singleton)

`_load_model()` is called once per container lifetime. It:

1. Imports `unimol.tasks.drugclip` — this file registers the `"drugclip"` task with Uni-Core's task registry via a `@register_task` decorator.
2. Imports `unimol.models.drugclip` — registers the `"drugclip"` architecture.
3. Builds an `argparse.Namespace` with all hyperparameters (15 encoder layers, 512 embed dim, 64 attention heads, batch size 8, etc.).
4. Calls `unicore_tasks.setup_task(args)` — instantiates the DrugCLIP task which also loads the atom/pocket vocabulary dictionaries (`dict_mol.txt`, `dict_pkt.txt`).
5. Calls `task.build_model(args)` — constructs the full two-tower model in PyTorch.
6. Loads `drugclip.pt` checkpoint with `checkpoint_utils.load_checkpoint_to_cpu` (loads to CPU regardless of device, then `.to(DEVICE)` moves it to GPU).
7. Sets `model.eval()` and caches in module-level `_MODEL`.

Total weight size: ~1.1 GB. First cold start takes ~60 seconds on T4. Subsequent calls use the in-memory cached model.

### 8.2 SMILES → 3-D conformer (parallel)

`_smiles_to_mol_record(smi)` for each of the 100 SMILES runs in a `ThreadPoolExecutor(max_workers=4)`:

1. `Chem.MolFromSmiles(smi)` — parses SMILES string into a 2-D RDKit molecule. Returns `None` for invalid SMILES.
2. Rejects molecules with `> 50` heavy atoms (too large for the model's positional encoding).
3. `Chem.AddHs(mol)` — adds explicit hydrogens required for 3-D embedding.
4. `AllChem.EmbedMolecule(mol, ETKDG())` — generates a single 3-D conformer using **ETKDG** (Experimental-Torsion Knowledge Distance Geometry). This is a distance-geometry algorithm seeded with experimental torsion angle statistics from the CSD.
5. If ETKDG fails (returns −1), retries with `useRandomCoords=True`.
6. `Chem.RemoveHs(mol)` — strips hydrogens back out for efficiency.
7. Returns `{ atoms: ["C","C","O",...], coordinates: [[[x,y,z],...]], smi: "CCO" }`.

### 8.3 Pocket extraction from PDB text

`_pdb_to_pocket_records(pdb_text, pocket_id)`:

- Parses `ATOM` records (protein atoms) and `HETATM` records (ligand atoms, excluding water).
- Coordinates are read from columns 31–54 of each PDB line (fixed-width format).
- For AlphaFold PDB files (no ligand), all protein atoms are kept and the 256 nearest to the geometric centroid are selected. The cap of 256 matches the model's `max_pocket_atoms` hyperparameter.
- Returns `[{ pocket_atoms, pocket_coordinates, pocket: pocket_id }]`.

### 8.4 LMDB serialisation

Both datasets are written to temporary LMDB files in `/tmp/drugclip_{random}/`. Each record is `pickle.dumps()`-ed and stored under its sequential integer key. LMDB is used because Uni-Core's built-in `LMDBDataset` class expects this exact format.

### 8.5 Encoding on GPU

Both `_encode_mols()` and `_encode_pockets()` iterate PyTorch DataLoader batches, move tensors to CUDA, run the relevant encoder tower, extract the `[CLS]` token representation, project to 128-D, and L2-normalise. Gradients are disabled (`torch.no_grad()`). The output numpy arrays are concatenated across batches.

### 8.6 Scoring and cleanup

```python
scores = (pocket_embs @ mol_embs.T).max(axis=0)
```

- `pocket_embs` shape: `(1, 128)` (one pocket)
- `mol_embs` shape: `(N, 128)`
- Result: `(N,)` — one cosine similarity per molecule

Sorted descending, top 100 returned. Temporary LMDB files are deleted with `shutil.rmtree`.

---

## 9. Modal Deployment Deep Dive

### Container Image (`modal_app.py`)

The image is built in layers (cached individually by Modal):

| Layer | What it does |
|---|---|
| `nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04` | Base OS with CUDA 12.1 + cuDNN 8 |
| `apt_install(...)` | git, build-essential, OpenGL libs (needed by RDKit) |
| `pip_install(torch==2.1.2, cu121)` | PyTorch with CUDA 12.1 support |
| `pip_install(fastapi, rdkit-pypi, lmdb, ...)` | Application dependencies |
| `run_function(_install_unicore)` | Clones Uni-Core, strips its CUDA extension build system, installs Python-only version |
| `run_commands("git clone DrugCLIP")` | Clones the DrugCLIP repo to `/app/DrugCLIP` |
| `run_function(_patch_drugclip)` | Two source patches (see below) |
| `add_local_file(main.py, ...)` | Embeds `main.py`, `drugclip_inference.py`, `SMILES.csv` into the image |

### Source Patches Applied at Build Time

**Patch 1 — `unimol/tasks/drugclip.py`:** The original file has a bare top-level `from IPython import embed as debug_embedded` that raises `ImportError` outside a Jupyter notebook. Wrapped in `try/except`.

**Patch 2 — `unimol/models/drugclip.py`:** The original hardcodes `device="cuda"` when initialising the `logit_scale` parameter. Replaced with a runtime check `"cuda" if torch.cuda.is_available() else "cpu"` so the model can also load on CPU (useful for local testing).

### Modal Function Configuration

```python
@app.function(
    image=image,
    gpu="T4",
    volumes={_WEIGHTS_DIR: weights_volume},
    timeout=1800,          # 30-minute max execution time
    scaledown_window=600,  # container stays alive 10 minutes after last request
    min_containers=1,      # always keep one warm container (eliminates cold starts)
)
```

- `timeout=1800` — a single `/discover` request can take up to 30 minutes (though typically 30–120 seconds).
- `scaledown_window=600` — the container is not killed immediately after a request finishes; it stays warm for 10 minutes. Useful if users run back-to-back discoveries.
- `min_containers=1` — Modal always keeps one container running. This prevents cold starts (~60 s GPU warm-up + model load). Costs ~$0.50/hr on a T4.

### The `weights_volume` (Modal Volume)

DrugCLIP's checkpoint (`drugclip.pt`, ~1.1 GB) is stored in a **Modal Volume** named `drugclip-weights`. The volume is mounted at `/app/DrugCLIP/weights/pretrain_weights/` inside the container. This means the weights are downloaded **once** and persist across container restarts and redeployments — you do not pay for repeated downloads.

---

## 10. Model Weights

The `drugclip.pt` checkpoint is not bundled in this repository. It must be uploaded to the Modal Volume before the first request.

### Upload steps

```bash
# 1. Download weights from the official DrugCLIP HuggingFace repo
#    (check the DrugCLIP paper / GitHub for the current download link)
wget https://huggingface.co/bowen-gao/DrugCLIP/resolve/main/drugclip.pt

# 2. Upload to the Modal Volume
modal volume put drugclip-weights drugclip.pt /drugclip.pt
```

The container's `web()` function checks for the weights file at startup and raises a descriptive `RuntimeError` with upload instructions if the file is missing.

---

## 11. Molecule Database

**File:** `python-worker/SMILES.csv`

A curated CSV with two columns:

```
ID,SMILES
ZINC000001234567,CC(=O)OC1=CC=CC=C1C(=O)O
...
```

- `ID` — a unique identifier, typically a ZINC database ID.
- `SMILES` — the canonical SMILES string for the molecule.

At each `/discover` request, **100 molecules are randomly sampled** from this list. This means results vary between runs (intentional — to give coverage of the library over multiple queries).

To expand or customise the library, replace `SMILES.csv` with any CSV that has `ID` and `SMILES` columns and redeploy:

```bash
cd python-worker
modal deploy modal_app.py
```

---

## 12. Environment Variables Reference

### `backend/.env`

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Express server port |
| `PYTHON_WORKER_URL` | `http://worker:8000` | Full URL to the Modal ASGI endpoint |
| `PYTHON_WORKER_TIMEOUT_MS` | `15000` | Timeout for non-DrugCLIP Modal calls (ms) |
| `PYTHON_WORKER_DRUGCLIP_TIMEOUT_MS` | `600000` | Timeout for `/discover` and `/drugclip` (ms). Set to `1800000` (30 min) in production. |
| `ALPHAFOLD_API_URL` | `https://alphafold.ebi.ac.uk/api` | AlphaFold EBI base URL |
| `ZINC22_API_URL` | `https://zinc22.docking.org/substances.txt` | (unused in current flow) |
| `ENAMINE_API_URL` | `https://new.enaminestore.com/api/v1` | (unused in current flow) |

### `frontend/.env` (optional)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:4000` | Backend base URL. Override for production deployments. |

---

## 13. Key Files Reference

```
virtual-cell/
├── README.md                          Quick start guide
├── ARCHITECTURE.md                    This file
├── docker-compose.yml                 Legacy: MongoDB + Redis + Qdrant (not needed for current flow)
│
├── frontend/
│   └── src/
│       ├── pages/
│       │   └── DiscoveryDashboard.jsx  Main page — all UI state, API call
│       ├── components/
│       │   ├── ProteinViewer.jsx       Three.js 3-D protein renderer
│       │   ├── SimulationTimeline.jsx  Pipeline progress steps
│       │   └── QueueProgress.jsx       (Legacy, unused)
│       └── utils/
│           └── smilesToName.js         PubChem SMILES → compound name resolver
│
├── backend/
│   └── src/
│       ├── index.js                    Entry point (starts Express)
│       ├── app.js                      Middleware + route mounting
│       ├── routes/
│       │   └── discoveryRoutes.js      POST /discover route
│       ├── controllers/
│       │   └── discoveryController.js  Request handler (AlphaFold + Modal calls)
│       └── services/
│           ├── alphafoldService.js     AlphaFold EBI API client
│           ├── pythonWorkerService.js  Modal HTTP client
│           ├── gridfsService.js        (Legacy, unused — GridFS for MongoDB)
│           └── moleculeService.js      (Legacy, unused — ZINC/Enamine molecule fetcher)
│
└── python-worker/
    ├── modal_app.py                    Modal container image + deployment config
    ├── main.py                         FastAPI app (all HTTP endpoints)
    ├── drugclip_inference.py           DrugCLIP model loading + inference pipeline
    └── SMILES.csv                      Molecule library (ID + SMILES columns)
```

---

## 14. Local Development Setup

### Prerequisites

- Node.js 20+
- Python 3.11+
- A Modal account (`modal.com`) with the CLI installed

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env: set PYTHON_WORKER_URL to your Modal endpoint
npm install
npm run dev
# → http://localhost:4000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

### Python Worker (local testing without Modal)

You can run the FastAPI app locally for testing if you have the DrugCLIP weights and dependencies installed. This requires a CUDA GPU or MPS (Apple Silicon):

```bash
cd python-worker
pip install fastapi uvicorn pandas rdkit-pypi torch lmdb tqdm scipy scikit-learn
# Also install Uni-Core and clone DrugCLIP repo to ./DrugCLIP/
uvicorn main:app --host 0.0.0.0 --port 8000
```

Set `PYTHON_WORKER_URL=http://localhost:8000` in `backend/.env`.

---

## 15. Deploying the Python Worker

```bash
# 1. Install Modal CLI
pip install modal
modal token new   # opens browser auth

# 2. Deploy
cd python-worker
modal deploy modal_app.py
```

Modal prints the deployment URL:
```
✓ Created web endpoint: https://info-amritpant--virtual-cell-worker-web.modal.run
```

Copy this into `backend/.env` as `PYTHON_WORKER_URL`.

### Re-deploying after code changes

Any change to `main.py`, `drugclip_inference.py`, or `SMILES.csv` requires a redeploy:

```bash
cd python-worker
modal deploy modal_app.py
```

Modal detects which image layers changed (only the `add_local_file` layers are affected by source changes) and rebuilds only those layers — much faster than a full rebuild.

### Serve mode (temporary, for testing)

```bash
modal serve modal_app.py
```

The endpoint is alive only while this command runs. Useful for quick iteration.

---

## 16. Troubleshooting

### Scores are −10.5 (very negative numbers)

**Cause:** A stale Modal container from a previous deployment is still running old code. Old code used `logit_scale`-based scoring (temperature-scaled dot product, unbounded) instead of cosine similarity (bounded 0–1).

**Fix:**
```bash
cd python-worker
# Step 1: set min_containers=0 in modal_app.py, then deploy → kills all stale containers
modal deploy modal_app.py
# Step 2: restore min_containers=1, redeploy → fresh warm container with correct code
modal deploy modal_app.py
```

After step 2, verify by hitting `/health` and checking `device` is `cuda`.

### No requests appearing in the Modal dashboard

The backend is likely not reaching Modal at all. Check:
1. `backend/.env` has `PYTHON_WORKER_URL` set (not the default `http://worker:8000`).
2. The backend terminal shows `[pythonWorkerService] PYTHON_WORKER_URL = https://...` (not `http://worker:8000`).
3. The Modal deployment is live: `modal app list` should show `virtual-cell-worker` as deployed.

### "Protein not found" error

The UniProt ID is not in the AlphaFold database. AlphaFold covers most reviewed human proteins but not all. Common valid IDs to test with:

| ID | Protein |
|---|---|
| `P05067` | Amyloid precursor protein (Alzheimer's) |
| `P00533` | Epidermal growth factor receptor (EGFR) |
| `P04637` | Tumour protein p53 |
| `Q9Y6K9` | BRAF kinase |

### DrugCLIP takes too long / times out

DrugCLIP on a cold T4 container takes ~60 s for model loading + ~30–60 s for inference on 100 molecules. Total: ~2 minutes on a warm container, up to ~3 minutes cold.

If you see timeouts, increase `PYTHON_WORKER_DRUGCLIP_TIMEOUT_MS` in `backend/.env` (default is 1 800 000 ms = 30 minutes, which should be sufficient).

To eliminate cold starts, ensure `min_containers=1` in `modal_app.py` and that the deployment is live.

### Frontend shows "Resolving…" for all compound names

The PubChem API is rate-limited. Names resolve asynchronously in batches of 8. If you see "Resolving…" for more than ~30 seconds, PubChem may be temporarily unreachable. The SMILES string is always shown in the tooltip on hover regardless.
