import { STAGES } from '../useProfileLookup';

/**
 * What is happening during the wait, over the skeleton.
 *
 * A profile lookup drives a real browser through LinkedIn's own lazy loading and
 * then through a "show all" page per truncated section, so 30-40 seconds is
 * normal rather than a fault. A bare skeleton for that long reads as a hang.
 */
export function Progress({ stage }: { stage: number }) {
  const current = STAGES[Math.min(stage, STAGES.length - 1)];

  return (
    <div className="panel progress" aria-busy="true" aria-live="polite">
      <ol className="progress-steps">
        {STAGES.map((step, index) => {
          const state = index < stage ? 'done' : index === stage ? 'active' : 'todo';
          return (
            <li key={step.label} className={`progress-step ${state}`}>
              <span className="progress-dot" aria-hidden="true">
                {state === 'done' ? '✓' : index + 1}
              </span>
              <span className="progress-label">{step.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="progress-detail">{current?.detail}</p>
    </div>
  );
}
