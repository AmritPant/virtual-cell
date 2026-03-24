// SMILES-to-compound-name resolver using PubChem PUG REST API (free, no key needed)

const PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";

// In-memory cache: SMILES string → resolved name
const nameCache = new Map();

// Track in-flight requests to avoid duplicate fetches
const pendingRequests = new Map();

/**
 * Resolve a SMILES string to a compound name via PubChem.
 * Returns the cached name synchronously if available, otherwise
 * returns a placeholder and fetches in the background.
 * Components should call `resolveCompoundName` and re-render when it resolves.
 */
export function getCompoundName(smiles) {
  const raw = String(smiles || "").trim();
  if (!raw) return "Unknown";

  if (nameCache.has(raw)) return nameCache.get(raw);

  // Return placeholder immediately; the async resolver populates the cache
  return "Resolving…";
}

/**
 * Async function that resolves a SMILES string to a human-readable compound name.
 * Uses PubChem PUG REST — completely free, no API key.
 * Caches results so each SMILES is fetched at most once.
 */
export async function resolveCompoundName(smiles) {
  const raw = String(smiles || "").trim();
  if (!raw) return "Unknown";

  // Return cached
  if (nameCache.has(raw)) return nameCache.get(raw);

  // De-duplicate concurrent requests for the same SMILES
  if (pendingRequests.has(raw)) return pendingRequests.get(raw);

  const promise = fetchNameFromPubChem(raw);
  pendingRequests.set(raw, promise);

  try {
    const name = await promise;
    nameCache.set(raw, name);
    return name;
  } finally {
    pendingRequests.delete(raw);
  }
}

/**
 * Resolve a batch of SMILES strings in parallel (with concurrency limit).
 * Returns a Map of smiles → name.
 */
export async function resolveCompoundNames(smilesList) {
  const unique = [...new Set(smilesList.map((s) => String(s || "").trim()).filter(Boolean))];
  const BATCH = 8;
  for (let i = 0; i < unique.length; i += BATCH) {
    await Promise.allSettled(unique.slice(i, i + BATCH).map(resolveCompoundName));
  }
  const result = new Map();
  for (const s of smilesList) {
    result.set(s, nameCache.get(String(s || "").trim()) || "Unknown");
  }
  return result;
}

// ---- internal ----

async function fetchNameFromPubChem(smiles) {
  try {
    // Step 1: Get CID from SMILES
    const cidUrl = `${PUBCHEM_BASE}/compound/smiles/${encodeURIComponent(smiles)}/cids/JSON`;
    const cidRes = await fetch(cidUrl, { signal: AbortSignal.timeout(8000) });
    if (!cidRes.ok) return generateFallbackName(smiles);

    const cidData = await cidRes.json();
    const cid = cidData?.IdentifierList?.CID?.[0];
    if (!cid || cid === 0) return generateFallbackName(smiles);

    // Step 2: Get preferred IUPAC name / title
    const propUrl = `${PUBCHEM_BASE}/compound/cid/${cid}/property/IUPACName,Title/JSON`;
    const propRes = await fetch(propUrl, { signal: AbortSignal.timeout(8000) });
    if (!propRes.ok) return `CID-${cid}`;

    const propData = await propRes.json();
    const props = propData?.PropertyTable?.Properties?.[0];
    // Prefer the common "Title" (e.g. "Aspirin") over the IUPAC name
    const title = props?.Title;
    const iupac = props?.IUPACName;

    if (title && title.length < 60) return title;
    if (iupac && iupac.length < 80) return iupac;
    return title || iupac || `CID-${cid}`;
  } catch {
    return generateFallbackName(smiles);
  }
}

function generateFallbackName(smiles) {
  // Simple structural hint when PubChem is unreachable
  if (smiles.includes("c1ccc") || smiles.includes("C1=CC=CC=C1")) return "Aromatic Compound";
  if (smiles.includes("C(=O)O")) return "Carboxylic Acid";
  if (smiles.includes("C(=O)N")) return "Amide";
  if (smiles.includes("C=O")) return "Carbonyl Compound";
  if (smiles.includes("OH") || smiles.includes("[OH]")) return "Alcohol";
  if (smiles.includes("N")) return "Amine";
  return "Compound";
}
