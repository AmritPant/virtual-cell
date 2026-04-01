import axios from "axios";
import { streamRemoteFileToGridFs } from "./gridfsService.js";

const API_URL = process.env.ALPHAFOLD_API_URL || "https://alphafold.ebi.ac.uk/api";

export async function fetchAlphaFoldModel(uniprotId) {
  const lookupUrl = `${API_URL}/prediction/${encodeURIComponent(uniprotId)}`;
  try {
    const response = await axios.get(lookupUrl, { timeout: 15000 });
    if (!Array.isArray(response.data) || response.data.length === 0) {
      const err = new Error(`Protein "${uniprotId}" not found in AlphaFold database.`);
      err.code = "PROTEIN_NOT_FOUND";
      throw err;
    }
    return response.data[0];
  } catch (error) {
    if (error.code === "PROTEIN_NOT_FOUND") throw error;
    if (error.response && error.response.status === 404) {
      const err = new Error(`Protein "${uniprotId}" not found in AlphaFold database. Please check the UniProt ID.`);
      err.code = "PROTEIN_NOT_FOUND";
      throw err;
    }
    if (error.code === "ECONNABORTED" || (error.message && error.message.includes("timeout"))) {
      const err = new Error("AlphaFold database request timed out. Please try again.");
      err.code = "ALPHAFOLD_TIMEOUT";
      throw err;
    }
    if (error.code === "ECONNREFUSED") {
      const err = new Error("AlphaFold service is temporarily unavailable.");
      err.code = "SERVICE_UNAVAILABLE";
      throw err;
    }
    throw error;
  }
}

export async function persistAlphaFoldStructure(model, uniprotId) {
  const fileUrl = model?.pdbUrl || model?.cifUrl;
  if (!fileUrl) return null;

  const extension = fileUrl.endsWith(".pdb") ? "pdb" : "cif";
  return streamRemoteFileToGridFs(fileUrl, `${uniprotId}.${extension}`);
}

export async function fetchAlphaFoldPdbContent(model) {
  const pdbUrl = model?.pdbUrl;
  if (!pdbUrl) return null;
  try {
    const response = await axios.get(pdbUrl, { timeout: 30000, responseType: "text" });
    return typeof response.data === "string" ? response.data : null;
  } catch (err) {
    console.error("Failed to download AlphaFold PDB content:", err.message);
    return null;
  }
}
