/** Placeholder shown while a lookup is in flight. Mirrors the real layout so the
 *  page does not jump when results replace it. */
export function Skeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="panel hero-skeleton">
        <div className="sk sk-avatar" />
        <div className="sk-lines">
          <div className="sk sk-line w60" />
          <div className="sk sk-line w40" />
          <div className="sk sk-line w30" />
        </div>
      </div>
      {[0, 1].map((i) => (
        <div className="panel" key={i}>
          <div className="sk sk-line w30" />
          <div className="sk sk-line" />
          <div className="sk sk-line w80" />
        </div>
      ))}
    </div>
  );
}
