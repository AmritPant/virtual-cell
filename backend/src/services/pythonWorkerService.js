import axios from "axios";

const workerUrl = process.env.PYTHON_WORKER_URL || "http://worker:8000";
console.log(`[pythonWorkerService] PYTHON_WORKER_URL = ${workerUrl}`);
const requestTimeoutMs = Number(process.env.PYTHON_WORKER_TIMEOUT_MS || 15000);
// DrugCLIP inference (2x 15-layer transformers) takes several minutes
const drugclipTimeoutMs = Number(process.env.PYTHON_WORKER_DRUGCLIP_TIMEOUT_MS || 600000);

function normalizeWorkerUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${url}`;
}

async function postToWorker(path, payload, timeoutMs = requestTimeoutMs) {
  const baseUrl = normalizeWorkerUrl(workerUrl);
  try {
    const response = await axios.post(`${baseUrl}${path}`, payload, { timeout: timeoutMs });
    const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
    if (contentType && !contentType.includes("application/json")) {
      throw new Error(`unexpected content-type ${contentType}`);
    }
    if (typeof response.data === "string") {
      throw new Error("worker returned string payload instead of JSON");
    }
    return response.data;
  } catch (error) {
    throw new Error(`Python worker unreachable (${baseUrl}${path}): ${error.message}`);
  }
}

export async function runFastFold({ uniprotId }) {
  return postToWorker("/fast-fold", { uniprotId });
}

export async function runFpocket({ structureFileId }) {
  return postToWorker("/fpocket", { structureFileId });
}

export async function runDrugClip({ pockets, molecules, pdb_content }) {
  return postToWorker("/drugclip", { pockets, molecules, pdb_content }, drugclipTimeoutMs);
}

export async function runVina({ smiles, sessionId }) {
  return postToWorker("/vina", { smiles, sessionId });
}

export async function runDiscover({ pdb_content, protein_id }) {
  return postToWorker("/discover", { pdb_content, protein_id }, drugclipTimeoutMs);
}
