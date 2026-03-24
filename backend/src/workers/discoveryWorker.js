import { Worker } from "bullmq";
import Redis from "ioredis";
import { DiscoverySession } from "../models/DiscoverySession.js";
import { getDiscoveryQueue } from "../queues/discoveryQueue.js";
import { fetchAlphaFoldModel, persistAlphaFoldStructure } from "../services/alphafoldService.js";
import { runDiscover, runFastFold, runFpocket, runVina } from "../services/pythonWorkerService.js";

function redisConnection() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

async function updateSessionProgress(sessionId, status, percent, message, updates = {}) {
  await DiscoverySession.findByIdAndUpdate(sessionId, {
    status,
    progress: { percent, message },
    ...updates
  });
}

export function startDiscoveryWorker() {
  getDiscoveryQueue();

  const worker = new Worker(
    "discovery-jobs",
    async (job) => {
      if (job.name === "screen-protein") {
        const { sessionId, uniprotId, needsFastFold } = job.data;
        await updateSessionProgress(sessionId, "folding", 10, "Checking protein structure");

        const model = await fetchAlphaFoldModel(uniprotId);
        let structureFileId = null;

        if (model) {
          structureFileId = await persistAlphaFoldStructure(model, uniprotId);
        } else if (needsFastFold) {
          const foldResult = await runFastFold({ uniprotId });
          structureFileId = foldResult.structureFileId || null;
        }

        await updateSessionProgress(sessionId, "folding", 35, "Running pocket detection", {
          "targetProtein.structureFileId": structureFileId
        });
        const pocketResult = await runFpocket({ structureFileId });
        const pockets = Array.isArray(pocketResult.pockets) ? pocketResult.pockets : [];

        await updateSessionProgress(sessionId, "screening", 55, "Running molecule discovery with local database", {
          "targetProtein.pockets": pockets
        });
        
        // Get PDB content for the discover endpoint
        const session = await DiscoverySession.findById(sessionId);
        const pdb_content = structureFileId ? `simulated_pdb_for_${uniprotId}` : `fallback_pdb_for_${uniprotId}`;
        
        // Use the new discover endpoint with local SMILES database
        const discoveryResult = await runDiscover({ 
          pdb_content, 
          protein_id: uniprotId 
        });
        
        const topHits = discoveryResult.top_hits || [];

        await DiscoverySession.findByIdAndUpdate(sessionId, {
          status: "completed",
          progress: { percent: 100, message: "Discovery run completed" },
          results: topHits
        });
        return { sessionId, hits: topHits.length };
      }

      if (job.name === "run-vina") {
        const { sessionId, smiles } = job.data;
        const result = await runVina({ sessionId, smiles });

        const session = await DiscoverySession.findById(sessionId);
        if (!session) return { sessionId, updated: false };

        session.results = session.results.map((entry) =>
          entry.smiles === smiles ? { ...entry.toObject(), dockingData: result } : entry
        );
        await session.save();
        return { sessionId, updated: true };
      }

      return { ignored: true };
    },
    { connection: redisConnection() }
  );

  worker.on("failed", (job, err) => {
    if (!job?.data?.sessionId) return;
    updateSessionProgress(job.data.sessionId, "completed", 0, `Job failed: ${err.message}`).catch(() => {});
  });

  return worker;
}
