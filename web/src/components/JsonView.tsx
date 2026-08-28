import { useMemo } from 'react';

type Token = { text: string; cls: string };

/**
 * Tokenises JSON for display.
 *
 * Returns tokens rather than an HTML string so React renders the text as text —
 * profile data goes through the normal escaping path and cannot inject markup,
 * which a `dangerouslySetInnerHTML` highlighter would have to get right by hand.
 */
const TOKEN_RE =
  /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function tokenize(json: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;

  for (const match of json.matchAll(TOKEN_RE)) {
    const value = match[0];
    const index = match.index;
    if (index > last) tokens.push({ text: json.slice(last, index), cls: '' });

    let cls = 'tok-num';
    if (value.startsWith('"')) cls = value.endsWith(':') ? 'tok-key' : 'tok-str';
    else if (value === 'true' || value === 'false') cls = 'tok-bool';
    else if (value === 'null') cls = 'tok-null';

    tokens.push({ text: value, cls });
    last = index + value.length;
  }

  if (last < json.length) tokens.push({ text: json.slice(last), cls: '' });
  return tokens;
}

export function JsonView({ value }: { value: unknown }) {
  const tokens = useMemo(() => tokenize(JSON.stringify(value, null, 2)), [value]);

  return (
    <pre className="json">
      {tokens.map((token, i) =>
        token.cls ? (
          <span className={token.cls} key={i}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </pre>
  );
}
