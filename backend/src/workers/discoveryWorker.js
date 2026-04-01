import { Worker } from "bullmq";
import Redis from "ioredis";
import { DiscoverySession } from "../models/DiscoverySession.js";
import { getDiscoveryQueue } from "../queues/discoveryQueue.js";
import { fetchAlphaFoldModel, persistAlphaFoldStructure, fetchAlphaFoldPdbContent } from "../services/alphafoldService.js";
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
        console.log(`[worker] calling /fpocket for session ${sessionId}`);
        const pocketResult = await runFpocket({ structureFileId });
        console.log(`[worker] /fpocket OK, pockets: ${JSON.stringify(pocketResult.pockets?.length)}`);
        const pockets = Array.isArray(pocketResult.pockets) ? pocketResult.pockets : [];

        await updateSessionProgress(sessionId, "screening", 55, "Running molecule discovery with local database", {
          "targetProtein.pockets": pockets
        });
        
        // Download real PDB content for DrugCLIP inference
        if (!model) {
          throw new Error(`No AlphaFold structure available for ${uniprotId}. Cannot run DrugCLIP without a real PDB structure.`);
        }
        console.log(`[worker] fetching AlphaFold PDB content for ${uniprotId}`);
        const pdb_content = await fetchAlphaFoldPdbContent(model);
        if (!pdb_content) {
          throw new Error(`Failed to download PDB content for ${uniprotId} from AlphaFold.`);
        }
        console.log(`[worker] PDB content fetched (${pdb_content.length} bytes), calling /discover on Modal...`);

        // Run DrugCLIP with real PDB content
        const discoveryResult = await runDiscover({
          pdb_content,
          protein_id: uniprotId
        });
        console.log(`[worker] /discover returned ${discoveryResult?.top_hits?.length} hits`);

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
    console.error(`[worker] JOB FAILED session=${job?.data?.sessionId}: ${err.message}`);
    if (!job?.data?.sessionId) return;
    updateSessionProgress(job.data.sessionId, "completed", 0, `Job failed: ${err.message}`).catch(() => {});
  });

  return worker;
}
