# Virtual Cell

Monorepo boilerplate for a real-time AI drug discovery workflow.

## Structure

- `frontend/`: React + Vite discovery dashboard with Three.js (`@react-three/fiber` + `drei`)
- `backend/`: Express API gateway, Mongoose schema, BullMQ queue
- `python-worker/`: Python worker runtime stub for Fast-Fold/Fpocket/DrugCLIP/Vina jobs
- `docker-compose.yml`: API + worker + MongoDB + Redis + Qdrant services

## Quick Start

1. Backend:
   - Copy `backend/.env.example` to `backend/.env`
   - `cd backend && npm install && npm run dev`
2. Frontend:
   - `cd frontend && npm install && npm run dev`
3. Full stack with containers:
   - `docker compose up --build`

## API Endpoints

- `POST /api/discovery/sessions`
- `GET /api/discovery/sessions/:sessionId/status`
- `POST /api/discovery/sessions/:sessionId/screen`
- `POST /api/discovery/sessions/:sessionId/validate`
- `GET /health`

## Phase 2 Pipeline Notes

- AlphaFold metadata is fetched in backend and structure files are persisted to MongoDB GridFS.
- BullMQ worker runs the async sequence: fold lookup/fast-fold -> fpocket -> molecule fetch -> DrugCLIP ranking.
- Python worker now exposes HTTP endpoints (`/fast-fold`, `/fpocket`, `/drugclip`, `/vina`) for orchestration.
- Dashboard starts a session and polls live status/progress from Redis-backed job updates via Mongo session state.
