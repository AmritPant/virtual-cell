import { useEffect, useMemo, useState, useRef } from "react";
import {
  Bell, Database, FlaskConical,
  Search, Zap, Network, Microscope
} from "lucide-react";
import ProteinViewer from "../components/ProteinViewer";
import SimulationTimeline from "../components/SimulationTimeline";
import { getCompoundName, resolveCompoundNames } from "../utils/smilesToName.js";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

export default function DiscoveryDashboard() {
  const [selectedPocket, setSelectedPocket] = useState(null);
  const [sessionId, setSessionId] = useState("");
  const [statusLabel, setStatusLabel] = useState("Idle");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("queued");
  const [uniprotId, setUniprotId] = useState("");
  const [viewMode, setViewMode] = useState("pocket");
  const [pdbUrl, setPdbUrl] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [compoundNames, setCompoundNames] = useState(new Map());
  const viewerRef = useRef(null);
  const fallbackPockets = useMemo(
    () => [
      { id: "p1", position: [0.8, 0.2, 0.4] },
      { id: "p2", position: [-0.5, -0.2, 0.9] },
      { id: "p3", position: [0.1, 0.7, -0.7] }
    ],
    []
  );
  const [serverPockets, setServerPockets] = useState([]);

  async function startSession() {
    const trimmed = uniprotId.trim();
    if (!trimmed) {
      setError("Please enter a UniProt ID (e.g. P00533, Q9Y6K9).");
      return;
    }

    if (!/^[A-Za-z0-9_-]{2,20}$/.test(trimmed)) {
      setError("Invalid UniProt ID format. IDs are typically 6\u201310 alphanumeric characters (e.g. P00533).");
      return;
    }

    setError("");
    setStatusLabel("Starting discovery...");

    try {
      const response = await fetch(`${API_BASE}/api/discovery/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proteinName: "Target Protein",
          uniprotId: trimmed,
          librarySource: "zinc22",
          minAffinity: -7.5
        })
      });

      if (!response.ok) {
        let errorMsg = "Something went wrong. Please try again.";
        try {
          const errData = await response.json();
          errorMsg = errData.message || errorMsg;
        } catch { /* response not JSON */ }

        if (response.status === 404) {
          setError(errorMsg.includes("not found") ? errorMsg : `Protein "${trimmed}" was not found. Please verify the UniProt ID is correct.`);
        } else {
          setError(errorMsg);
        }
        setStatusLabel("Idle");
        return;
      }

      const data = await response.json();
      setSessionId(data.sessionId);
      setStatusLabel(data.progress?.message || "Queued");
      setProgress(data.progress?.percent || 0);
      setStatus(data.status || "queued");
    } catch (err) {
      console.error("Discovery session error:", err);
      if (err.name === "TypeError" && err.message.includes("fetch")) {
        setError("Cannot reach the server. Please make sure the backend is running.");
      } else {
        setError("Network error. Please check your connection and try again.");
      }
      setStatusLabel("Idle");
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(async () => {
      const response = await fetch(`${API_BASE}/api/discovery/sessions/${sessionId}/status`);
      if (!response.ok) return;
      const data = await response.json();
      setStatusLabel(data.progress?.message || data.status);
      setProgress(data.progress?.percent || 0);
      setStatus(data.status || "screening");
      setServerPockets(Array.isArray(data.pockets) ? data.pockets : []);
      setPdbUrl(data.pdbUrl || "");
      setResults(Array.isArray(data.results) ? data.results : []);
    }, 2000);

    return () => clearInterval(timer);
  }, [sessionId]);

  useEffect(() => {
    if (results.length === 0) return;
    const smilesList = results.slice(0, 20).map((r) => r.smiles);
    resolveCompoundNames(smilesList).then((names) => setCompoundNames(new Map(names)));
  }, [results]);

  return (
    <>
      {/* ─── Top Navigation Bar ────────────────────────────────────── */}
      <header className="topNav">
        <div style={{ display: "flex", alignItems: "center" }}>
          <span className="brand">Virtual Cell</span>
          <nav>
            <a className="active">Discovery</a>
            <a>Library</a>
            <a>Reports</a>
          </nav>
        </div>
        <div className="topNavRight">
          <div style={{ position: "relative" }}>
            <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--on-surface-variant)" }} />
            <input className="searchBox" placeholder="Search structures..." />
          </div>
          <span className="navIcon"><Bell size={16} /></span>
          <span className="navIcon"><Microscope size={16} /></span>
          <div className="avatar" />
        </div>
      </header>

      <div className="appShell">
        {/* ─── Main Content ──────────────────────────────────────────── */}
        <main className="dashboard">
          {/* Left Control Column */}
          <aside className="sidebar">
            {/* Discovery Control */}
            <section className="glassCard">
              <h2 className="headline">
                <FlaskConical size={16} className="headlineIcon" />
                Discovery Control
              </h2>
              <label htmlFor="uniprot" className="label">UniProt ID</label>
              <input
                id="uniprot"
                value={uniprotId}
                onChange={(e) => {
                  setUniprotId(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && startSession()}
                className={`input ${error ? "error" : ""}`}
                placeholder="e.g. P05067"
              />
              {error && <div className="errorMessage">{error}</div>}

              <div className="infoChipsRow">
                <div className="infoChip">
                  <span className="chipLabel">Target Type</span>
                  <span className="chipValue">Protein Target</span>
                </div>
                <div className="infoChip">
                  <span className="chipLabel">Complexity</span>
                  <span className="chipValue tertiary">High (Grade 4)</span>
                </div>
              </div>

              <button onClick={startSession} className="primaryButton" disabled={!uniprotId.trim()}>
                Start Discovery Cycle
              </button>
            </section>

            {/* Real-Time Simulation */}
            <SimulationTimeline status={status} progressLabel={statusLabel} progress={progress} />
          </aside>

          {/* Right Viewport Column */}
          <section className="viewportArea">
            <ProteinViewer
              ref={viewerRef}
              pockets={serverPockets.length > 0 ? serverPockets : fallbackPockets}
              onPocketSelect={(pocket) => {
                setSelectedPocket(pocket);
                setViewMode("pocket");
              }}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              pdbUrl={pdbUrl}
            />

            {/* Stats Row */}
            <div className="statsRow">
              <div className="statCard">
                <div className="statCardHead">
                  <div className="statIcon"><Database size={16} /></div>
                  <div className="statLabel">Structural Database</div>
                </div>
                <p className="statCardValue">4.2M <span className="unit">Compounds</span></p>
              </div>
              <div className="statCard">
                <div className="statCardHead">
                  <div className="statIcon green"><Zap size={16} /></div>
                  <div className="statLabel">Processing Power</div>
                </div>
                <p className="statCardValue">12.8 <span className="unit">PFLOPS</span></p>
              </div>
              <div className="statCard">
                <div className="statCardHead">
                  <div className="statIcon amber"><Network size={16} /></div>
                  <div className="statLabel">Active Nodes</div>
                </div>
                <p className="statCardValue">1,024 <span className="unit">Clusters</span></p>
              </div>
            </div>

          </section>

          {/* Right Molecules Column */}
          <section className="moleculesPanel">
            <h3 className="sectionTitle">Top Molecules Found</h3>
            {results.length === 0 ? (
              <p className="muted">No ranked molecules yet. Results appear after DrugCLIP completes.</p>
            ) : (
              <div className="resultsTable" role="table" aria-label="top molecule results">
                <div className="resultsHeader" role="row">
                  <span role="columnheader">#</span>
                  <span role="columnheader">Compound</span>
                  <span role="columnheader">Score</span>
                </div>
                {results.slice(0, 20).map((item, idx) => (
                  <div
                    className="resultsRow"
                    role="row"
                    key={`${item.smiles}-${idx}`}
                    onClick={() => {
                      const pocketId = item.pocketId || item.pocket?.id;
                      if (pocketId && viewerRef.current?.zoomToMolecule) {
                        viewerRef.current.zoomToMolecule(pocketId);
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <span>{idx + 1}</span>
                    <span className="compoundName" title={item.smiles}>{compoundNames.get(item.smiles) || getCompoundName(item.smiles)}</span>
                    <span>{typeof item.score === "number" ? item.score.toFixed(3) : "-"}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    </>
  );
}
