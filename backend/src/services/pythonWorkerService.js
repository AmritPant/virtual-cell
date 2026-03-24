import axios from "axios";

const workerUrl = process.env.PYTHON_WORKER_URL || "http://worker:8000";
const workerFallbackUrl = "http://localhost:8000";
const requestTimeoutMs = Number(process.env.PYTHON_WORKER_TIMEOUT_MS || 15000);

function normalizeWorkerUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `https://${url}`;
}

async function postToWorker(path, payload) {
  const primaryUrl = normalizeWorkerUrl(workerUrl);
  const fallbackUrl = normalizeWorkerUrl(workerFallbackUrl);
  const targets = primaryUrl === fallbackUrl ? [primaryUrl] : [primaryUrl, fallbackUrl];
  let lastError = null;

  for (const baseUrl of targets) {
    try {
      const response = await axios.post(`${baseUrl}${path}`, payload, { timeout: requestTimeoutMs });
      const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
      if (contentType && !contentType.includes("application/json")) {
        throw new Error(`unexpected content-type ${contentType}`);
      }
      if (typeof response.data === "string") {
        throw new Error("worker returned string payload instead of JSON");
      }
      return response.data;
    } catch (error) {
      lastError = error;
    }
  }

  const errMessage = lastError?.message || "unknown worker connectivity failure";
  throw new Error(`Python worker unreachable (${targets.join(", ")}): ${errMessage}`);
}

export async function runFastFold({ uniprotId }) {
  return postToWorker("/fast-fold", { uniprotId });
}

export async function runFpocket({ structureFileId }) {
  return postToWorker("/fpocket", { structureFileId });
}

export async function runDrugClip({ pockets, molecules }) {
  return postToWorker("/drugclip", { pockets, molecules });
}

export async function runVina({ smiles, sessionId }) {
  return postToWorker("/vina", { smiles, sessionId });
}

export async function runDiscover({ pdb_content, protein_id }) {
  return postToWorker("/discover", { pdb_content, protein_id });
}
