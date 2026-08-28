import { z } from 'zod';

/**
 * The public response contract.
 *
 * Two rules hold everywhere: every section is always present (arrays default to
 * [], scalars to null) so clients never need existence checks, and anything the
 * extractor could not reach is reported in `meta.missingSections` rather than
 * being silently omitted.
 */

export const ImageRenditionSchema = z.object({
  width: z.number(),
  height: z.number(),
  url: z.string(),
});

export const ImageAssetSchema = z.object({
  assetUrn: z.string().nullable().default(null),
  renditions: z.array(ImageRenditionSchema).default([]),
  /** Largest available rendition — the one most callers want. */
  url: z.string().nullable().default(null),
});

export const DateRangeSchema = z.object({
  /** Exactly as LinkedIn rendered it, e.g. "Jan 2020 - Present". */
  text: z.string().nullable().default(null),
  start: z.string().nullable().default(null),
  end: z.string().nullable().default(null),
  /** e.g. "3 yrs 2 mos", when LinkedIn supplies it. */
  duration: z.string().nullable().default(null),
  isCurrent: z.boolean().default(false),
});

export const ExperienceSchema = z.object({
  title: z.string().nullable().default(null),
  company: z.string().nullable().default(null),
  employmentType: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  dateRange: DateRangeSchema.nullable().default(null),
  description: z.string().nullable().default(null),
  skills: z.array(z.string()).default([]),
  companyUrl: z.string().nullable().default(null),
  logo: ImageAssetSchema.nullable().default(null),
});

export const EducationSchema = z.object({
  school: z.string().nullable().default(null),
  degree: z.string().nullable().default(null),
  fieldOfStudy: z.string().nullable().default(null),
  grade: z.string().nullable().default(null),
  dateRange: DateRangeSchema.nullable().default(null),
  description: z.string().nullable().default(null),
  schoolUrl: z.string().nullable().default(null),
  logo: ImageAssetSchema.nullable().default(null),
});

export const SkillSchema = z.object({
  name: z.string(),
  endorsementCount: z.number().nullable().default(null),
  /** e.g. "Endorsed by 3 colleagues at Acme". */
  context: z.array(z.string()).default([]),
});

export const CertificationSchema = z.object({
  name: z.string().nullable().default(null),
  issuer: z.string().nullable().default(null),
  issuedDate: z.string().nullable().default(null),
  expiryDate: z.string().nullable().default(null),
  credentialId: z.string().nullable().default(null),
  credentialUrl: z.string().nullable().default(null),
  logo: ImageAssetSchema.nullable().default(null),
});

export const LanguageSchema = z.object({
  name: z.string(),
  proficiency: z.string().nullable().default(null),
});

/** Projects, honors, volunteering, publications, courses, patents, organisations. */
export const GenericEntrySchema = z.object({
  title: z.string().nullable().default(null),
  subtitle: z.string().nullable().default(null),
  caption: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
});

export const ContactInfoSchema = z.object({
  profileUrl: z.string().nullable().default(null),
  websites: z.array(z.object({ url: z.string(), label: z.string().nullable().default(null) })).default([]),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  twitter: z.string().nullable().default(null),
  birthday: z.string().nullable().default(null),
  connectedDate: z.string().nullable().default(null),
});

export const LocationSchema = z.object({
  text: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
});

export const ProfileSchema = z.object({
  publicIdentifier: z.string(),
  canonicalUrl: z.string(),
  profileUrn: z.string().nullable().default(null),
  memberUrn: z.string().nullable().default(null),

  firstName: z.string().nullable().default(null),
  lastName: z.string().nullable().default(null),
  fullName: z.string().nullable().default(null),
  headline: z.string().nullable().default(null),
  location: LocationSchema.nullable().default(null),
  about: z.string().nullable().default(null),

  profilePicture: ImageAssetSchema.nullable().default(null),
  backgroundImage: ImageAssetSchema.nullable().default(null),

  followerCount: z.number().nullable().default(null),
  connectionCount: z.string().nullable().default(null),
  /** "1st" / "2nd" / "3rd" relative to the authenticated session. */
  networkDistance: z.string().nullable().default(null),
  isPremium: z.boolean().default(false),
  isOpenToWork: z.boolean().default(false),

  experience: z.array(ExperienceSchema).default([]),
  education: z.array(EducationSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  certifications: z.array(CertificationSchema).default([]),
  languages: z.array(LanguageSchema).default([]),
  projects: z.array(GenericEntrySchema).default([]),
  honors: z.array(GenericEntrySchema).default([]),
  volunteer: z.array(GenericEntrySchema).default([]),
  publications: z.array(GenericEntrySchema).default([]),
  courses: z.array(GenericEntrySchema).default([]),
  organizations: z.array(GenericEntrySchema).default([]),
  recommendations: z.array(GenericEntrySchema).default([]),

  contactInfo: ContactInfoSchema.nullable().default(null),
});

export const MetaSchema = z.object({
  /** Which acquisition paths actually contributed data. */
  strategy: z.enum(['html', 'cache']),
  sources: z.array(z.string()).default([]),
  /** Sections the extractor could not reach. Empty means a complete profile. */
  missingSections: z.array(z.string()).default([]),
  partial: z.boolean().default(false),
  cached: z.boolean().default(false),
  fetchedAt: z.string(),
  durationMs: z.number(),
  warnings: z.array(z.string()).default([]),
});

export const ProfileResponseSchema = z.object({
  profile: ProfileSchema,
  meta: MetaSchema,
});

export type ImageRendition = z.infer<typeof ImageRenditionSchema>;
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export type DateRange = z.infer<typeof DateRangeSchema>;
export type Experience = z.infer<typeof ExperienceSchema>;
export type Education = z.infer<typeof EducationSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type Certification = z.infer<typeof CertificationSchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type GenericEntry = z.infer<typeof GenericEntrySchema>;
export type ContactInfo = z.infer<typeof ContactInfoSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

/** Section keys addressable by the details-page resolver, in display order. */
export const SECTION_KEYS = [
  'experience',
  'education',
  'skills',
  'certifications',
  'languages',
  'projects',
  'honors',
  'volunteer',
  'publications',
  'courses',
  'organizations',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Maps our section keys to LinkedIn's /details/<slug>/ route names. */
export const SECTION_ROUTES: Record<SectionKey, string> = {
  experience: 'experience',
  education: 'education',
  skills: 'skills',
  certifications: 'certifications',
  languages: 'languages',
  projects: 'projects',
  honors: 'honors',
  volunteer: 'volunteering-experiences',
  publications: 'publications',
  courses: 'courses',
  organizations: 'organizations',
};
