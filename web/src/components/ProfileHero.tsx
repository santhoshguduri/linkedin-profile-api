import type { Profile } from '../api';
import { Badge } from './primitives';

export function ProfileHero({ profile }: { profile: Profile }) {
  const name =
    profile.fullName ??
    [profile.firstName, profile.lastName].filter(Boolean).join(' ') ??
    profile.publicIdentifier;

  return (
    <div className="hero">
      <div
        className="hero-banner"
        style={
          profile.backgroundImage?.url
            ? { backgroundImage: `url("${profile.backgroundImage.url}")` }
            : undefined
        }
      />
      <div className="hero-body">
        {profile.profilePicture?.url ? (
          <img className="hero-avatar" src={profile.profilePicture.url} alt={name} />
        ) : (
          <div className="hero-avatar" aria-hidden="true" />
        )}

        <h2>
          <a href={profile.canonicalUrl} target="_blank" rel="noopener noreferrer">
            {name}
          </a>
        </h2>
        {profile.headline && <p className="headline">{profile.headline}</p>}
        {profile.location?.text && <p className="location">{profile.location.text}</p>}

        <div className="hero-badges">
          {profile.networkDistance && <Badge tone="accent">{profile.networkDistance}</Badge>}
          {profile.isPremium && <Badge tone="warn">Premium</Badge>}
          {profile.isOpenToWork && <Badge tone="ok">Open to work</Badge>}
          {profile.followerCount !== null && (
            <Badge>{profile.followerCount.toLocaleString()} followers</Badge>
          )}
          {profile.connectionCount && <Badge>{profile.connectionCount} connections</Badge>}
        </div>
      </div>
    </div>
  );
}
