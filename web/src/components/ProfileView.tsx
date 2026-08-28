import type { Profile } from '../api';
import { ProfileHero } from './ProfileHero';
import { ContactCard } from './ContactCard';
import { Entry, Pill, Section, dateText, joinDot } from './primitives';

/** Sections rendered as a plain title/subtitle/date list. */
const GENERIC = [
  ['projects', 'Projects'],
  ['honors', 'Honors & awards'],
  ['volunteer', 'Volunteering'],
  ['publications', 'Publications'],
  ['courses', 'Courses'],
  ['organizations', 'Organizations'],
] as const;

export function ProfileView({ profile }: { profile: Profile }) {
  return (
    <>
      <ProfileHero profile={profile} />

      {profile.about && (
        <Section title="About">
          <p className="about-text">{profile.about}</p>
        </Section>
      )}

      {profile.experience.length > 0 && (
        <Section title="Experience" count={profile.experience.length}>
          {profile.experience.map((role, i) => (
            <Entry
              key={`${role.title}-${role.company}-${i}`}
              logo={role.logo}
              title={role.title}
              subtitle={joinDot(role.company, role.employmentType)}
              meta={joinDot(dateText(role.dateRange), role.location)}
              description={role.description}
              href={role.companyUrl}
            />
          ))}
        </Section>
      )}

      {profile.education.length > 0 && (
        <Section title="Education" count={profile.education.length}>
          {profile.education.map((school, i) => (
            <Entry
              key={`${school.school}-${i}`}
              logo={school.logo}
              title={school.school}
              subtitle={joinDot(school.degree, school.fieldOfStudy)}
              meta={joinDot(dateText(school.dateRange), school.grade && `Grade: ${school.grade}`)}
              description={school.description}
              href={school.schoolUrl}
            />
          ))}
        </Section>
      )}

      {profile.skills.length > 0 && (
        <Section title="Skills" count={profile.skills.length}>
          <div className="pill-list">
            {profile.skills.map((skill, i) => (
              <Pill key={`${skill.name}-${i}`} label={skill.name} note={skill.endorsementCount} />
            ))}
          </div>
        </Section>
      )}

      {profile.certifications.length > 0 && (
        <Section title="Licenses & certifications" count={profile.certifications.length}>
          {profile.certifications.map((cert, i) => (
            <Entry
              key={`${cert.name}-${i}`}
              logo={cert.logo}
              title={cert.name}
              subtitle={cert.issuer}
              meta={joinDot(
                cert.issuedDate && `Issued ${cert.issuedDate}`,
                cert.expiryDate && `Expires ${cert.expiryDate}`,
                cert.credentialId && `ID ${cert.credentialId}`,
              )}
              href={cert.credentialUrl}
            />
          ))}
        </Section>
      )}

      {profile.languages.length > 0 && (
        <Section title="Languages" count={profile.languages.length}>
          <div className="pill-list">
            {profile.languages.map((lang, i) => (
              <Pill key={`${lang.name}-${i}`} label={lang.name} note={lang.proficiency} />
            ))}
          </div>
        </Section>
      )}

      {GENERIC.map(([key, title]) => {
        const items = profile[key];
        if (items.length === 0) return null;
        return (
          <Section title={title} count={items.length} key={key}>
            {items.map((item, i) => (
              <Entry
                key={`${item.title}-${i}`}
                title={item.title}
                subtitle={item.subtitle}
                meta={item.caption}
                description={item.description}
                href={item.url}
              />
            ))}
          </Section>
        );
      })}

      {profile.contactInfo && <ContactCard contact={profile.contactInfo} />}
    </>
  );
}
