import axios from "axios";

const zincApiUrl = process.env.ZINC22_API_URL || "https://zinc22.docking.org/substances.txt";
const enamineApiUrl = process.env.ENAMINE_API_URL || "https://new.enaminestore.com/api/v1";
const demoValidSmiles = [
  "CC(=O)OC1=CC=CC=C1C(=O)O",
  "CC(C)CC1=CC=C(C=C1)C(C)C(=O)O",
  "CC1=CC(=O)NC(=O)N1",
  "CCOC(=O)C1=CC=CC=C1Cl",
  "CN1CCC(CC1)C2=CN=CC=C2",
  "CCN(CC)CCOC(=O)C1=CC=CC=C1",
  "CC1=C(C=C(C=C1)O)C(=O)O",
  "CC(C)NCC(O)COC1=CC=CC=C1",
  "CCOC(=O)N1CCC(CC1)C2=CC=CC=C2",
  "COC1=CC=CC=C1OCCN"
];

function looksLikeHtml(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("<!doctype") || text.includes("<html") || text.includes("</body>");
}

function isLikelySmiles(smiles) {
  if (typeof smiles !== "string") return false;
  const s = smiles.trim();
  if (!s || s.length < 2 || s.length > 240) return false;
  if (looksLikeHtml(s)) return false;
  // Conservative character whitelist for common SMILES tokens.
  return /^[A-Za-z0-9@+\-\[\]\(\)=#$\\/%.]+$/.test(s);
}

async function fetchFromZinc22(limit) {
  // ZINC22 API - fetch random molecules using their public API
  const zincUrl = "https://zinc22.docking.org/substances.txt";
  const response = await axios.get(zincUrl, { 
    timeout: 15000,
    headers: {
      'User-Agent': 'Virtual-Cell/1.0'
    }
  });
  
  if (looksLikeHtml(response.data)) {
    throw new Error("ZINC22 returned HTML page instead of molecular data");
  }
  
  const lines = String(response.data).split("\n").filter(Boolean);
  
  // Randomize the order and take unique molecules
  const shuffled = lines.sort(() => 0.5 - Math.random());
  const uniqueLines = [...new Set(shuffled)].slice(0, limit);
  
  return uniqueLines
    .map((line, idx) => ({
      smiles: line.split(/\s+/)[0],
      source: "zinc22"
    }))
    .filter((entry) => isLikelySmiles(entry.smiles));
}

async function fetchFromEnamine(limit) {
  const response = await axios.get(`${enamineApiUrl}/compounds`, {
    params: { limit },
    timeout: 15000,
    headers: {
      'User-Agent': 'Virtual-Cell/1.0'
    }
  });
  const compounds = Array.isArray(response.data?.items) ? response.data.items : [];
  
  // Randomize order to get different molecules each time
  const shuffled = compounds.sort(() => 0.5 - Math.random());
  
  return shuffled
    .map((item) => ({
      smiles: item.smiles || item.canonicalSmiles,
      source: "enamine"
    }))
    .filter((entry) => isLikelySmiles(entry.smiles))
    .slice(0, limit);
}

export async function fetchCandidateMolecules({ source = "zinc22", limit = 100 }) {
  const cappedLimit = Math.min(limit, 500);
  
  try {
    if (source === "enamine") {
      const enamine = await fetchFromEnamine(cappedLimit);
      if (enamine.length > 0) return enamine;
    }
    
    const zinc = await fetchFromZinc22(cappedLimit);
    if (zinc.length > 0) return zinc;
    
    throw new Error(`Unable to fetch molecules from ${source}`);
  } catch (error) {
    console.error(`Failed to fetch molecules from ${source}:`, error.message);
    throw new Error(`Molecule fetching failed: ${error.message}. Please check your network connection and API availability.`);
  }
}

export async function validateSmilesWithRdkit(smilesList) {
  // Minimal server-side sanity filter; replace with @rdkit/rdkit strict parsing when fully provisioned.
  return smilesList.filter((m) => isLikelySmiles(m.smiles));
}
