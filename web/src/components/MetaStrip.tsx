import type { Meta } from '../api';
import { Badge } from './primitives';

/** Surfaces how the result was obtained and what is missing from it. A partial
 *  profile is the normal case, so it is stated rather than hidden. */
export function MetaStrip({ meta }: { meta: Meta }) {
  return (
    <div className="meta-strip">
      <Badge tone="accent">{meta.strategy}</Badge>
      <Badge>{meta.durationMs} ms</Badge>
      {meta.cached && <Badge tone="ok">cached</Badge>}
      {meta.partial && <Badge tone="warn">partial</Badge>}
      {meta.missingSections.map((section) => (
        <Badge key={section}>no {section}</Badge>
      ))}
      {meta.warnings.map((warning) => (
        <Badge tone="warn" key={warning}>
          {warning}
        </Badge>
      ))}
    </div>
  );
}
