import { type FormEvent } from 'react';

const EXAMPLES = ['williamhgates', 'satyanadella'];

export function SearchBar({
  url,
  onUrlChange,
  refresh,
  onRefreshChange,
  onSubmit,
  busy,
}: {
  url: string;
  onUrlChange: (value: string) => void;
  refresh: boolean;
  onRefreshChange: (value: boolean) => void;
  onSubmit: (url: string) => void;
  busy: boolean;
}) {
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(url);
  };

  return (
    <form className="search" onSubmit={handleSubmit} autoComplete="off">
      <div className="field">
        <svg className="field-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 4a6 6 0 104.47 10.03l4.25 4.25 1.41-1.41-4.25-4.25A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z" />
        </svg>
        <input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          type="text"
          spellCheck={false}
          placeholder="https://www.linkedin.com/in/williamhgates/"
          aria-label="LinkedIn profile URL"
          required
        />
        <button type="submit" disabled={busy || url.trim().length === 0}>
          {busy && <span className="spinner" aria-hidden="true" />}
          <span>{busy ? 'Fetching' : 'Fetch'}</span>
        </button>
      </div>

      <div className="options">
        <label className="check">
          <input
            type="checkbox"
            checked={refresh}
            onChange={(e) => onRefreshChange(e.target.checked)}
          />
          <span>Bypass cache</span>
        </label>

        <div className="examples">
          <span>Try:</span>
          {EXAMPLES.map((slug) => {
            const full = `https://www.linkedin.com/in/${slug}/`;
            return (
              <button
                type="button"
                className="chip"
                key={slug}
                onClick={() => {
                  onUrlChange(full);
                  onSubmit(full);
                }}
              >
                {slug}
              </button>
            );
          })}
        </div>
      </div>
    </form>
  );
}
