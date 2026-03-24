import { CheckCircle, Atom, Activity, FlaskConical, ShieldCheck } from "lucide-react";

const ICONS = {
  queued: CheckCircle,
  folding: Atom,
  pocket: Activity,
  screening: FlaskConical,
  completed: ShieldCheck
};

const SUBTITLES = {
  queued: "Worker node assigned",
  folding: "High-confidence pLDDT check",
  pocket: "Binding site detection",
  screening: "Molecular Docking Analysis",
  completed: "Results ready"
};

export default function SimulationTimeline({ status, progressLabel, progress }) {
  const steps = [
    { key: "queued", label: "Session queued" },
    { key: "folding", label: "Fetching AlphaFold structure" },
    { key: "pocket", label: "Analyzing binding pocket" },
    { key: "screening", label: "Running DrugCLIP screening" },
    { key: "completed", label: "Discovery completed" }
  ];

  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.key === status)
  );

  return (
    <section className="cardLow simSection">
      <div className="simHeader">
        <h3 className="sectionTitle" style={{ margin: 0 }}>Real-Time Simulation</h3>
        <span className="liveBadge">LIVE</span>
      </div>

      <ul className="timeline" aria-label="pipeline progress timeline">
        {steps.map((step, index) => {
          const Icon = ICONS[step.key];
          const state = index < currentIndex ? "done" : index === currentIndex ? "active" : "pending";
          const isLast = index === steps.length - 1;

          return (
            <li key={step.key} className={`timelineItem ${state}`}>
              <div className="timelineLeft">
                <span className="timelineIcon" aria-hidden="true">
                  <Icon size={13} />
                </span>
                {!isLast && <div className="timelineConnector" />}
              </div>
              <div className="timelineBody">
                <div className="stepLabel">{step.label}</div>
                {state === "active" && (
                  <>
                    <div className="timelineProgressRow">
                      <span className="stepSub">{progressLabel}</span>
                      <span className="pctLabel">{progress}%</span>
                    </div>
                    <div className="progressOuter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                      <div className="progressInner" style={{ width: `${progress}%` }} />
                    </div>
                  </>
                )}
                {state === "done" && (
                  <div className="stepSub">{SUBTITLES[step.key]}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
