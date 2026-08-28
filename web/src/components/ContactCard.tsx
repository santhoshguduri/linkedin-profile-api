import type { ContactInfo } from '../api';
import { Section } from './primitives';

interface Row {
  label: string;
  value: string;
  href?: string;
}

function rowsFor(contact: ContactInfo): Row[] {
  const rows: Row[] = [];
  const add = (label: string, value: string | null, href?: string) => {
    if (value) rows.push(href ? { label, value, href } : { label, value });
  };

  add('Email', contact.email, contact.email ? `mailto:${contact.email}` : undefined);
  add('Phone', contact.phone, contact.phone ? `tel:${contact.phone}` : undefined);
  add('Twitter', contact.twitter);
  add('Birthday', contact.birthday);
  add('Connected', contact.connectedDate);
  for (const site of contact.websites) {
    add(site.label || 'Website', site.url, site.url);
  }
  return rows;
}

export function ContactCard({ contact }: { contact: ContactInfo }) {
  const rows = rowsFor(contact);
  if (rows.length === 0) return null;

  return (
    <Section title="Contact info">
      <dl className="kv">
        {rows.map((row, i) => (
          <div className="kv-row" key={`${row.label}-${i}`}>
            <dt>{row.label}</dt>
            <dd>
              {row.href ? (
                <a href={row.href} target="_blank" rel="noopener noreferrer">
                  {row.value}
                </a>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
