# Virtual Cell

AI-powered drug discovery platform. Enter a UniProt protein ID → get ranked small-molecule candidates scored by the DrugCLIP foundation model running on a GPU in the cloud.

> For a full technical deep-dive into every component, request flow, and the DrugCLIP inference pipeline, see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite, Three.js (`@react-three/fiber`), Lucide icons |
| Backend | Node.js / Express (stateless, no database) |
| ML Worker | Python / FastAPI deployed on [Modal](https://modal.com) with T4 GPU |
| Model | DrugCLIP (Uni-Mol backbone, CLIP-style contrastive learning) |
| Protein structures | AlphaFold EBI public API |

## Quick Start

### 1. Backend

```bash
cd backend
cp .env.example .env        # fill in PYTHON_WORKER_URL (see below)
npm install
npm run dev                 # starts on http://localhost:4000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                 # starts on http://localhost:5173
```

### 3. Python Worker (Modal)

```bash
pip install modal
modal token new             # one-time auth

cd python-worker
modal deploy modal_app.py   # deploys to https://<you>--virtual-cell-worker-web.modal.run
```

Copy the printed URL into `backend/.env`:
```
PYTHON_WORKER_URL=https://<you>--virtual-cell-worker-web.modal.run
```

> The 1.1 GB model weights must be in the `drugclip-weights` Modal Volume before the first request.  
> See [ARCHITECTURE.md § Model Weights](./ARCHITECTURE.md#model-weights) for upload instructions.

## API

```
POST /api/discovery/discover   { uniprotId }  →  { pdbUrl, top_hits[] }
GET  /health
```

## Key Environment Variables (`backend/.env`)

| Variable | Purpose |
|---|---|
| `PYTHON_WORKER_URL` | Modal endpoint URL |
| `PYTHON_WORKER_DRUGCLIP_TIMEOUT_MS` | Max wait for DrugCLIP (default 1 800 000 ms = 30 min) |
| `ALPHAFOLD_API_URL` | AlphaFold EBI base URL |
