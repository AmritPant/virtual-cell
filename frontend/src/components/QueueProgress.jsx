export default function QueueProgress({ label, progress }) {
  return (
    <div className="panel">
      <h2>Pipeline Status</h2>
      <p>{label}</p>
      <div className="progressOuter">
        <div className="progressInner" style={{ width: `${progress}%` }} />
      </div>
      <p>{progress}% complete</p>
    </div>
  );
}
