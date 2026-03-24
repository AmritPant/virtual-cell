import { useEffect, useMemo, useState, useRef, forwardRef, useImperativeHandle, useCallback } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Sphere, Environment } from "@react-three/drei";
import { Layers, Orbit, ScanSearch } from "lucide-react";
import * as THREE from "three";

// ─── Pocket sphere palette ─────────────────────────────────────────────────────
const POCKET_COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#f87171"];
function pocketColor(i) { return POCKET_COLORS[i % POCKET_COLORS.length]; }

// ─── AlphaFold pLDDT confidence colour scale ──────────────────────────────────
function pLDDTColor(v) {
  if (v > 90) return new THREE.Color(0x0053d6);   // very high – dark blue
  if (v > 70) return new THREE.Color(0x65cbf3);   // confident – light blue
  if (v > 50) return new THREE.Color(0xffdb13);   // low – yellow
  return new THREE.Color(0xff7d45);                // very low – orange
}

// ─── Translucent glowing pocket sphere ─────────────────────────────────────────
function PocketSphere({ position, color, onClick, isSelected = false }) {
  const meshRef = useRef();
  const glowRef = useRef();
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const pulse = 1.0 + Math.sin(clock.getElapsedTime() * 2) * 0.08;
    meshRef.current.scale.setScalar(pulse);
    if (glowRef.current) glowRef.current.scale.setScalar(pulse * 1.35);
  });
  return (
    <group position={position} onClick={onClick}>
      <Sphere ref={glowRef} args={[0.32, 32, 32]}>
        <meshBasicMaterial color={isSelected ? "#f59e0b" : color} transparent opacity={isSelected ? 0.18 : 0.1} depthWrite={false} side={THREE.BackSide} />
      </Sphere>
      <Sphere ref={meshRef} args={[0.22, 32, 32]}>
        <meshPhysicalMaterial color={isSelected ? "#f59e0b" : color} emissive={isSelected ? "#f59e0b" : color} emissiveIntensity={isSelected ? 0.45 : 0.2} transparent opacity={0.55} roughness={0.15} metalness={0.1} clearcoat={0.4} depthWrite={false} />
      </Sphere>
    </group>
  );
}

// ─── Smooth fly-to animation ───────────────────────────────────────────────────
function animateFlyTo(controls, targetLookAt, duration = 1200) {
  if (!controls) return;
  const camera = controls.object;
  if (!camera) return;
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const lookAt = new THREE.Vector3(targetLookAt[0], targetLookAt[1], targetLookAt[2]);
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target).normalize().multiplyScalar(1.8);
  const endPos = lookAt.clone().add(offset);
  const startTime = performance.now();
  function tick() {
    const elapsed = performance.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(startPos, endPos, e);
    controls.target.lerpVectors(startTarget, lookAt, e);
    controls.update();
    if (t < 1) requestAnimationFrame(tick);
  }
  tick();
}

const views = [
  { id: "surface", label: "Surface", icon: Layers },
  { id: "ribbon", label: "Ribbon", icon: Orbit },
  { id: "pocket", label: "Pocket", icon: ScanSearch }
];

// ═══════════════════════════════════════════════════════════════════════════════
//  PDB PARSING – extract secondary structure, Cα positions, and B-factor/pLDDT
// ═══════════════════════════════════════════════════════════════════════════════

function computeTransform(positions) {
  if (positions.length === 0) return { cx: 0, cy: 0, cz: 0, scale: 1 };
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2]; }
  const count = positions.length / 3;
  cx /= count; cy /= count; cz /= count;
  let maxDist = 1;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx, dy = positions[i + 1] - cy, dz = positions[i + 2] - cz;
    maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return { cx, cy, cz, scale: 2 / maxDist };
}

function applyTransformFlat(positions, t) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i]     = (positions[i]     - t.cx) * t.scale;
    out[i + 1] = (positions[i + 1] - t.cy) * t.scale;
    out[i + 2] = (positions[i + 2] - t.cz) * t.scale;
  }
  return out;
}

function buildProteinGeometryData(pdbText) {
  const lines = pdbText.split("\n");

  // 1. Parse HELIX / SHEET records
  const helixRanges = [];
  const sheetRanges = [];
  for (const line of lines) {
    if (line.startsWith("HELIX")) {
      const ch = (line[19] || "").trim() || "_";
      const s  = parseInt(line.slice(21, 25));
      const e  = parseInt(line.slice(33, 37));
      if (!isNaN(s) && !isNaN(e)) helixRanges.push({ ch, s, e });
    }
    if (line.startsWith("SHEET")) {
      const ch = (line[21] || "").trim() || "_";
      const s  = parseInt(line.slice(22, 26));
      const e  = parseInt(line.slice(33, 37));
      if (!isNaN(s) && !isNaN(e)) sheetRanges.push({ ch, s, e });
    }
  }

  function getSSType(chainId, resSeq) {
    for (const h of helixRanges) if (h.ch === chainId && resSeq >= h.s && resSeq <= h.e) return "H";
    for (const s of sheetRanges) if (s.ch === chainId && resSeq >= s.s && resSeq <= s.e) return "E";
    return "C";
  }

  // 2. Parse ATOM records
  const atomPositions = [];
  const chains = [];
  let curChain = [];
  const seen = new Set();
  let prevCa = null;
  let prevChainId = null;

  function pushChain() {
    if (curChain.length >= 4) chains.push([...curChain]);
    curChain = [];
    prevCa = null;
  }

  for (const line of lines) {
    if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) continue;
    const atomName = line.slice(12, 16).trim();
    const altLoc  = line.slice(16, 17).trim();
    const chainId = line.slice(21, 22).trim() || "_";
    const resSeq  = parseInt(line.slice(22, 26));
    const iCode   = line.slice(26, 27).trim();
    const x = +line.slice(30, 38);
    const y = +line.slice(38, 46);
    const z = +line.slice(46, 54);
    const bFactor = +line.slice(60, 66) || 50;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    atomPositions.push(x, y, z);

    if (atomName === "CA" && (altLoc === "" || altLoc === "A")) {
      if (prevChainId && prevChainId !== chainId) pushChain();
      const key = `${chainId}:${resSeq}:${iCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (prevCa) {
        const dx = x - prevCa.x, dy = y - prevCa.y, dz = z - prevCa.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > 8) pushChain();
      }
      curChain.push({ x, y, z, ss: getSSType(chainId, resSeq), pLDDT: bFactor });
      prevCa = { x, y, z };
      prevChainId = chainId;
    }
  }
  pushChain();

  // 3. Normalise
  const tf = computeTransform(atomPositions);
  const normChains = chains.map(ch =>
    ch.map(r => ({
      x: (r.x - tf.cx) * tf.scale,
      y: (r.y - tf.cy) * tf.scale,
      z: (r.z - tf.cz) * tf.scale,
      ss: r.ss,
      pLDDT: r.pLDDT
    }))
  );
  return { atomPositions: applyTransformFlat(atomPositions, tf), chains: normChains };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECONDARY STRUCTURE SEGMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

function splitIntoSegments(chain) {
  if (chain.length === 0) return [];
  const segs = [];
  let type = chain[0].ss;
  let buf = [chain[0]];
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].ss !== type) {
      // overlap 1 residue for smooth joins
      segs.push({ type, residues: [...buf, chain[i]] });
      type = chain[i].ss;
      buf = [chain[i]];
    } else {
      buf.push(chain[i]);
    }
  }
  if (buf.length > 0) segs.push({ type, residues: buf });
  return segs;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GEOMETRY BUILDERS  (helix = wide ribbon, sheet = arrow, coil = thin tube)
// ═══════════════════════════════════════════════════════════════════════════════

// Interpolate pLDDT along a parametric curve
function interpolatePLDDT(residues, t) {
  const idx = Math.min(Math.floor(t * (residues.length - 1)), residues.length - 2);
  const frac = t * (residues.length - 1) - idx;
  return residues[idx].pLDDT * (1 - frac) + residues[Math.min(idx + 1, residues.length - 1)].pLDDT * frac;
}

function buildFlatRibbon(residues, width, arrowHead = false) {
  const pts = residues.map(r => new THREE.Vector3(r.x, r.y, r.z));
  if (pts.length < 3) return null;
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const N = Math.min(500, residues.length * 12);
  const frames = curve.computeFrenetFrames(N, false);
  const sampled = curve.getSpacedPoints(N);
  const verts = [], norms = [], cols = [], idxs = [];
  const baseHW = width / 2;
  const arrowHW = width * 0.9;
  const arrowStart = 0.7;

  for (let i = 0; i <= N; i++) {
    const P = sampled[i];
    const Ni = frames.normals[i];
    const B  = frames.binormals[i];
    const t  = i / N;
    const pLDDT = interpolatePLDDT(residues, t);
    const c = pLDDTColor(pLDDT);

    let hw = baseHW;
    if (arrowHead && t > arrowStart) {
      const at = (t - arrowStart) / (1 - arrowStart);
      hw = at < 0.25
        ? baseHW + (arrowHW - baseHW) * (at / 0.25)
        : arrowHW * Math.max(0, 1 - (at - 0.25) / 0.75);
    }

    const L = new THREE.Vector3().copy(P).addScaledVector(B, -hw);
    const R = new THREE.Vector3().copy(P).addScaledVector(B,  hw);
    verts.push(L.x, L.y, L.z, R.x, R.y, R.z);
    norms.push(Ni.x, Ni.y, Ni.z, Ni.x, Ni.y, Ni.z);
    cols.push(c.r, c.g, c.b, c.r, c.g, c.b);

    if (i < N) {
      const a = i * 2, b = a + 1, cc = a + 2, d = a + 3;
      idxs.push(a, cc, b, b, cc, d);   // front
      idxs.push(b, cc, a, d, cc, b);   // back
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("normal",   new THREE.Float32BufferAttribute(norms, 3));
  geo.setAttribute("color",    new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idxs);
  geo.computeVertexNormals();
  return geo;
}

function buildCoilTube(residues) {
  const pts = residues.map(r => new THREE.Vector3(r.x, r.y, r.z));
  if (pts.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const tubSeg = Math.min(200, residues.length * 8);
  const radSeg = 6;
  const geo = new THREE.TubeGeometry(curve, tubSeg, 0.012, radSeg, false);

  // per-vertex pLDDT colour
  const posAttr = geo.getAttribute("position");
  const colorArr = new Float32Array(posAttr.count * 3);
  const ring = radSeg + 1;
  for (let v = 0; v < posAttr.count; v++) {
    const t = Math.floor(v / ring) / tubSeg;
    const c = pLDDTColor(interpolatePLDDT(residues, Math.min(t, 1)));
    colorArr[v * 3] = c.r; colorArr[v * 3 + 1] = c.g; colorArr[v * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colorArr, 3));
  return geo;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REACT COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function SegmentMesh({ geometry, ssType }) {
  if (!geometry) return null;
  const flat = ssType === "H" || ssType === "E";
  return (
    <mesh geometry={geometry}>
      <meshPhysicalMaterial
        vertexColors
        metalness={flat ? 0.35 : 0.15}
        roughness={flat ? 0.32 : 0.55}
        clearcoat={flat ? 0.55 : 0.15}
        clearcoatRoughness={0.2}
        side={THREE.DoubleSide}
        envMapIntensity={0.9}
      />
    </mesh>
  );
}

function ProteinCartoon({ chains }) {
  const meshes = useMemo(() => {
    const out = [];
    for (const chain of chains) {
      const segs = splitIntoSegments(chain);
      for (const seg of segs) {
        let geo = null;
        if (seg.residues.length < 3 || seg.type === "C") {
          geo = buildCoilTube(seg.residues);
        } else if (seg.type === "H") {
          geo = buildFlatRibbon(seg.residues, 0.11);
        } else if (seg.type === "E") {
          geo = buildFlatRibbon(seg.residues, 0.13, true);
        }
        if (geo) out.push({ geo, type: seg.type });
      }
    }
    return out;
  }, [chains]);
  return (
    <group>
      {meshes.map((m, i) => <SegmentMesh key={i} geometry={m.geo} ssType={m.type} />)}
    </group>
  );
}

function ProteinAtomCloud({ atomPositions }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(atomPositions, 3));
    return g;
  }, [atomPositions]);
  return (
    <points geometry={geometry}>
      <pointsMaterial size={0.025} color="#60a5fa" sizeAttenuation transparent opacity={0.85} />
    </points>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
const ProteinViewer = forwardRef(({ pockets, onPocketSelect, viewMode, onViewModeChange, pdbUrl }, ref) => {
  const [atomPositions, setAtomPositions] = useState(new Float32Array([]));
  const [chains, setChains] = useState([]);
  const [loadingModel, setLoadingModel] = useState(false);
  const [selectedPocketId, setSelectedPocketId] = useState(null);
  const controlsRef = useRef();

  const handleFlyTo = useCallback((pocketId) => {
    if (!pockets || !pocketId) return;
    const target = pockets.find((p) => p.id === pocketId);
    if (!target || !Array.isArray(target.position) || target.position.length < 3) return;
    animateFlyTo(controlsRef.current, target.position);
    setSelectedPocketId(pocketId);
    onPocketSelect?.(target);
  }, [pockets, onPocketSelect]);

  useImperativeHandle(ref, () => ({ zoomToMolecule: handleFlyTo }), [handleFlyTo]);

  useEffect(() => {
    if (!pdbUrl) return;
    const controller = new AbortController();
    setLoadingModel(true);
    fetch(pdbUrl, { signal: controller.signal })
      .then((r) => r.text())
      .then((text) => {
        const data = buildProteinGeometryData(text);
        setAtomPositions(data.atomPositions);
        setChains(data.chains);
      })
      .catch(() => { setAtomPositions(new Float32Array([])); setChains([]); })
      .finally(() => setLoadingModel(false));
    return () => controller.abort();
  }, [pdbUrl]);

  return (
    <section className="viewerPanel">
      <header className="viewerHeader">
        <h2 className="sectionTitle">Discovery Viewport</h2>
        <div className="fabStack" role="group" aria-label="3d view controls">
          {views.map((v) => {
            const Icon = v.icon;
            const active = viewMode === v.id;
            return (
              <button key={v.id} type="button" className={`fab ${active ? "active" : ""}`} onClick={() => onViewModeChange(v.id)} aria-pressed={active} title={v.label}>
                <Icon size={14} />
                <span>{v.label}</span>
              </button>
            );
          })}
        </div>
      </header>
      <div className="viewerStatus">
        {loadingModel
          ? "Loading AlphaFold structure..."
          : pdbUrl
            ? <><strong style={{ color: "var(--primary)" }}>Protein Structure</strong> &middot; {viewMode === "ribbon" ? "Cartoon Rendering" : viewMode === "pocket" ? "Pocket Analysis" : "Atomic Surface"}<span className="statusBadge">3D ACTIVE</span></>
            : "No AlphaFold structure yet"}
      </div>
      <Canvas camera={{ position: [0, 0, 5], fov: 50 }} dpr={[1, 2]}>
        <ambientLight intensity={0.4} />
        <hemisphereLight skyColor="#b1e1ff" groundColor="#1e293b" intensity={0.6} />
        <directionalLight position={[5, 5, 5]} intensity={1.2} />
        <directionalLight position={[-3, -2, 4]} intensity={0.4} color="#a78bfa" />
        <pointLight position={[0, 3, 0]} intensity={0.3} color="#22d3ee" />
        <Environment preset="city" />

        {atomPositions.length > 0 ? (
          <>
            {viewMode === "surface" && <ProteinAtomCloud atomPositions={atomPositions} />}
            {(viewMode === "ribbon" || viewMode === "pocket") && <ProteinCartoon chains={chains} />}
          </>
        ) : (
          <Sphere args={[1.2, 64, 64]}>
            <meshPhysicalMaterial color="#1e293b" wireframe={viewMode !== "surface"} metalness={0.3} roughness={0.5} clearcoat={0.3} />
          </Sphere>
        )}

        {(viewMode === "pocket" || viewMode === "ribbon") &&
          pockets.map((pocket, idx) => (
            <PocketSphere key={pocket.id} position={pocket.position} color={pocketColor(idx)} isSelected={selectedPocketId === pocket.id}
              onClick={() => { setSelectedPocketId(pocket.id); onPocketSelect(pocket); animateFlyTo(controlsRef.current, pocket.position); }}
            />
          ))}

        <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.08} minDistance={1} maxDistance={15} />
      </Canvas>
    </section>
  );
});

export default ProteinViewer;
