import { fetchAlphaFoldModel, fetchAlphaFoldPdbContent } from "../services/alphafoldService.js";
import { runDiscover } from "../services/pythonWorkerService.js";

export async function discoverMolecules(req, res, next) {
  try {
    const { uniprotId } = req.body;

    if (!uniprotId || !uniprotId.trim()) {
      return res.status(400).json({
        message: "UniProt ID is required",
        error: "MISSING_UNIPROT_ID"
      });
    }

    const model = await fetchAlphaFoldModel(uniprotId.trim());

    const pdb_content = await fetchAlphaFoldPdbContent(model);
    if (!pdb_content) {
      return res.status(500).json({
        message: "Failed to download PDB structure from AlphaFold."
      });
    }

    const result = await runDiscover({ pdb_content, protein_id: uniprotId.trim() });

    res.json({
      pdbUrl: model.pdbUrl || null,
      top_hits: result.top_hits || []
    });
  } catch (error) {
    console.error("Discovery error:", error);

    if (error.code === "PROTEIN_NOT_FOUND") {
      return res.status(404).json({ message: error.message, error: "PROTEIN_NOT_FOUND" });
    }
    if (error.code === "ALPHAFOLD_TIMEOUT") {
      return res.status(408).json({ message: error.message, error: "ALPHAFOLD_TIMEOUT" });
    }
    if (error.code === "SERVICE_UNAVAILABLE") {
      return res.status(503).json({ message: error.message, error: "SERVICE_UNAVAILABLE" });
    }

    next(error);
  }
}
