import type { ReactNode } from 'react';
import type { ImageAsset, DateRange } from '../api';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/** Joins present parts with the separator LinkedIn itself uses between fields. */
export const joinDot = (...parts: Array<string | null | undefined | false>): string | null =>
  parts.filter(Boolean).join(' · ') || null;

export const dateText = (range: DateRange | null | undefined): string | null =>
  range?.text ?? null;

export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h3 className="section-title">
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

export interface EntryProps {
  logo?: ImageAsset | null;
  title: string | null;
  subtitle?: string | null;
  meta?: string | null;
  description?: string | null;
  href?: string | null;
}

export function Entry({ logo, title, subtitle, meta, description, href }: EntryProps) {
  const heading = title ?? '—';
  return (
    <div className="entry">
      {logo?.url ? (
        <img className="entry-logo" src={logo.url} alt="" loading="lazy" />
      ) : (
        <div className="entry-logo" aria-hidden="true" />
      )}
      <div className="entry-body">
        <p className="entry-title">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {heading}
            </a>
          ) : (
            heading
          )}
        </p>
        {subtitle && <p className="entry-sub">{subtitle}</p>}
        {meta && <p className="entry-meta">{meta}</p>}
        {description && <p className="entry-desc">{description}</p>}
      </div>
    </div>
  );
}

export function Pill({ label, note }: { label: string; note?: string | number | null }) {
  return (
    <span className="pill">
      <b>{label}</b>
      {note != null && <span className="n">{note}</span>}
    </span>
  );
}
