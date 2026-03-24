import { DiscoverySession } from "../models/DiscoverySession.js";
import { fetchAlphaFoldModel } from "../services/alphafoldService.js";
import { getDiscoveryQueue } from "../queues/discoveryQueue.js";
import { runDrugClip, runFpocket, runDiscover } from "../services/pythonWorkerService.js";
import { fetchCandidateMolecules, validateSmilesWithRdkit } from "../services/moleculeService.js";

export async function startDiscovery(req, res, next) {
  try {
    const { proteinName, uniprotId, librarySource, minAffinity } = req.body;
    
    // Validate required fields
    if (!uniprotId || !uniprotId.trim()) {
      return res.status(400).json({ 
        message: "UniProt ID is required",
        error: "MISSING_UNIPROT_ID" 
      });
    }

    const alphaFold = await fetchAlphaFoldModel(uniprotId.trim());

    const session = await DiscoverySession.create({
      targetProtein: {
        name: proteinName || "Target Protein",
        uniprotId: uniprotId.trim(),
        pdbUrl: alphaFold?.pdbUrl || null,
        pockets: []
      },
      searchParameters: { librarySource, minAffinity },
      status: alphaFold ? "screening" : "folding",
      progress: { percent: 5, message: "Session created and queued" }
    });

    await getDiscoveryQueue().add("screen-protein", {
      sessionId: session._id.toString(),
      uniprotId,
      needsFastFold: !alphaFold
    });

    res.status(202).json({
      sessionId: session._id,
      status: session.status,
      progress: session.progress
    });
  } catch (error) {
    console.error('Discovery start error:', error);
    
    if (error.code === "PROTEIN_NOT_FOUND") {
      return res.status(404).json({ 
        message: error.message,
        error: "PROTEIN_NOT_FOUND" 
      });
    }
    
    if (error.code === "ALPHAFOLD_TIMEOUT") {
      return res.status(408).json({ 
        message: error.message,
        error: "ALPHAFOLD_TIMEOUT" 
      });
    }
    
    if (error.code === "SERVICE_UNAVAILABLE") {
      return res.status(503).json({ 
        message: error.message,
        error: "SERVICE_UNAVAILABLE" 
      });
    }
    
    return res.status(500).json({ 
      message: "An unexpected error occurred. Please try again.",
      error: "INTERNAL_SERVER_ERROR" 
    });
  }
}

export async function runScreening(req, res, next) {
  try {
    const { sessionId } = req.params;
    const existing = await DiscoverySession.findById(sessionId);
    if (!existing) return res.status(404).json({ message: "Session not found" });
    await getDiscoveryQueue().add("screen-protein", {
      sessionId,
      uniprotId: existing.targetProtein.uniprotId,
      needsFastFold: false
    });
    res.status(202).json({ message: "Screening queued", sessionId });
  } catch (error) {
    next(error);
  }
}

export async function triggerDockingValidation(req, res, next) {
  try {
    const { sessionId } = req.params;
    const { smiles } = req.body;
    await getDiscoveryQueue().add("run-vina", { sessionId, smiles });
    res.status(202).json({ message: "AutoDock Vina job queued", sessionId, smiles });
  } catch (error) {
    next(error);
  }
}

export async function getSessionStatus(req, res, next) {
  try {
    const session = await DiscoverySession.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ message: "Session not found" });

    res.json({
      sessionId: session._id,
      status: session.status,
      progress: session.progress,
      pdbUrl: session.targetProtein?.pdbUrl || null,
      structureFileId: session.targetProtein?.structureFileId || null,
      pockets: session.targetProtein?.pockets || [],
      resultCount: Array.isArray(session.results) ? session.results.length : 0,
      results: Array.isArray(session.results) ? session.results.slice(0, 50) : []
    });
  } catch (error) {
    next(error);
  }
}

export async function discoverMolecules(req, res, next) {
  try {
    const { proteinId, pdb_content } = req.body;
    
    if (!pdb_content) {
      return res.status(400).json({ message: "PDB content is required" });
    }

    // Direct call to Python worker discover endpoint
    const result = await runDiscover({ pdb_content, protein_id: proteinId });
    
    res.json(result);
  } catch (error) {
    console.error("Discovery error:", error);
    next(error);
  }
}
