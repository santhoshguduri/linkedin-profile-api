import { describe, it, expect } from 'vitest';
import {
  decodeFlight,
  extractRehydrationChunks,
  tokenizeFlight,
  parseSentinel,
  findByViewName,
  findByType,
  collectImageAssets,
  textOf,
} from '../src/linkedin/ssr/index.js';

/**
 * Rows mirror the shapes observed in a live profile payload: client module refs,
 * lazy refs, Map rows, BigInt, escaped literals, deep path references and a cycle.
 */
const ROWS = [
  '1:I["64c7816bf91d8c7874af3e7af8b600c5",[],"default"]',
  '10:"$Sreact.fragment"',
  'f6:["$","h2",null,{"className":"_31136337","children":"Santhosh Guduri"}]',
  'f7:["$","p",null,{"children":"--"}]',
  'f8:["$","span",null,{"children":"Hyderabad, Telangana, India"}]',
  '3b:[["Follow","$L3c"],["Following","$L3d"]]',
  '3c:"followed"',
  '3d:"following"',
  '20:{"seconds":"$n86400","missing":"$undefined","frag":"$Sreact.fragment","literal":"$$notaref","asMap":"$Q3b"}',
  '21:{"nameCopy":"$f6:3:children","selfRef":"$21"}',
  '22:{"rootUrl":"https://media.licdn.com/dms/image/v2/D4E03AQFTDoIx1A2FYA/photo-","imageRenditions":[{"width":400,"height":400,"suffixUrl":"400_400/x?e=1"},{"width":100,"height":100,"suffixUrl":"100_100/x?e=1"}],"assetUrn":"urn:li:digitalmediaAsset:D4E03AQFTDoIx1A2FYA"}',
  '23:{"$type":"proto.sdui.actions.core.ReplaceComponent","componentKey":"profileCardsExperienceOnlyslug"}',
  '0:["$","div",null,{"children":["$Lf6","$Lf7","$Lf8"],"viewTrackingSpecs":[{"viewName":"profile-top-card"}]}]',
];

function pageWith(chunks: string[]): string {
  const payload = JSON.stringify(chunks);
  const open = '<script id="rehydrate-data" nonce="abc">window.__como_rehydration__ = ';
  return '<html><body>' + open + payload + '</script></body></html>';
}

/** One chunk per row, newline-terminated — the simple case. */
const SIMPLE_CHUNKS = ROWS.map((r) => r + '\n');

describe('parseSentinel', () => {
  it('treats a bare marker as an element marker, not a reference', () => {
    expect(parseSentinel('$')).toBeNull();
  });

  it('unescapes a doubled prefix to a literal', () => {
    expect(parseSentinel('$$notaref')).toEqual({ kind: 'literal', value: '$notaref' });
  });

  it.each([
    ['$undefined', undefined],
    ['$Infinity', Infinity],
    ['$-Infinity', -Infinity],
  ])('decodes constant %s', (input, expected) => {
    expect(parseSentinel(input as string)).toEqual({ kind: 'value', value: expected });
  });

  it('decodes BigInt sentinels to safe numbers', () => {
    expect(parseSentinel('$n86400')).toEqual({ kind: 'value', value: 86400 });
  });

  it('keeps oversized BigInts as strings rather than losing precision', () => {
    const huge = '9007199254740993';
    expect(parseSentinel('$n' + huge)).toEqual({ kind: 'value', value: huge });
  });

  it('separates the tag from the row id', () => {
    expect(parseSentinel('$Lf6')).toMatchObject({ kind: 'row', id: 'f6', tag: 'L', path: [] });
    expect(parseSentinel('$fb')).toMatchObject({ kind: 'row', id: 'fb', tag: '' });
  });

  it('splits deep path references', () => {
    expect(parseSentinel('$139:props:children:0:style')).toMatchObject({
      id: '139',
      path: ['props', 'children', '0', 'style'],
    });
  });

  it('rejects non-hex row ids', () => {
    expect(parseSentinel('$zzz')).toBeNull();
  });
});

describe('extractRehydrationChunks', () => {
  it('returns nothing when the page carries no payload (authwall / checkpoint)', () => {
    expect(extractRehydrationChunks('<html><body>nope</body></html>')).toEqual([]);
  });

  it('stops at the matching bracket, ignoring brackets inside strings', () => {
    const html = pageWith(['a:["not ] a terminator"]\n']);
    expect(extractRehydrationChunks(html)).toEqual(['a:["not ] a terminator"]\n']);
  });

  it('is unaffected by escaped quotes inside chunk strings', () => {
    const chunk = 'b:' + JSON.stringify(['say "hi" ]']) + '\n';
    expect(extractRehydrationChunks(pageWith([chunk]))).toEqual([chunk]);
  });
});

describe('tokenizeFlight', () => {
  it('separates id, tag and payload', () => {
    const rows = tokenizeFlight(SIMPLE_CHUNKS.join(''));
    expect(rows.get('1')?.tag).toBe('I');
    expect(rows.get('f6')?.tag).toBe('');
    expect(rows.get('f7')?.value).toEqual(['$', 'p', null, { children: '--' }]);
  });

  it('keeps a malformed row without discarding the rest of the stream', () => {
    const rows = tokenizeFlight('aa:{"broken":\nbb:"fine"\n');
    expect(rows.get('aa')?.malformed).toBe(true);
    expect(rows.get('bb')?.value).toBe('fine');
  });
});

describe('decodeFlight', () => {
  const decoded = decodeFlight(pageWith(SIMPLE_CHUNKS));

  it('reassembles rows split across arbitrary chunk boundaries', () => {
    const stream = SIMPLE_CHUNKS.join('');
    const shredded: string[] = [];
    for (let i = 0; i < stream.length; i += 7) shredded.push(stream.slice(i, i + 7));
    expect(shredded.length).toBeGreaterThan(10);

    const fromShredded = decodeFlight(pageWith(shredded));
    expect(fromShredded.rows.size).toBe(decoded.rows.size);
    expect(fromShredded.malformedRows).toEqual([]);
  });

  it('resolves lazy references through to leaf text', () => {
    expect(textOf(decoded.root)).toBe('Santhosh Guduri -- Hyderabad, Telangana, India');
  });

  it('resolves Map rows into plain objects', () => {
    const row = decoded.resolver.row('20') as Record<string, unknown>;
    expect(row.asMap).toEqual({ Follow: 'followed', Following: 'following' });
  });

  it('decodes scalar sentinels inside an object row', () => {
    const row = decoded.resolver.row('20') as Record<string, unknown>;
    expect(row.seconds).toBe(86400);
    expect(row.missing).toBeUndefined();
    expect(row.literal).toBe('$notaref');
    expect(row.frag).toEqual({ __flightSymbol: 'react.fragment' });
  });

  it('follows deep path references', () => {
    const row = decoded.resolver.row('21') as Record<string, unknown>;
    expect(row.nameCopy).toBe('Santhosh Guduri');
  });

  it('terminates on a self-referential row instead of overflowing the stack', () => {
    const row = decoded.resolver.row('21') as Record<string, unknown>;
    expect(row.selfRef).toHaveProperty('$circular', '21');
  });

  it('marks client module rows without treating them as data', () => {
    expect(decoded.resolver.row('1')).toMatchObject({ __flightModule: true, tag: 'I' });
  });

  it('reports an empty payload rather than throwing', () => {
    const empty = decodeFlight('<html></html>');
    expect(empty.isEmpty).toBe(true);
    expect(empty.root).toBeUndefined();
  });
});

describe('query helpers', () => {
  const decoded = decodeFlight(pageWith(SIMPLE_CHUNKS));

  it('finds nodes by viewTrackingSpecs.viewName', () => {
    expect(findByViewName(decoded.tree, 'profile-top-card').length).toBeGreaterThan(0);
  });

  it('finds nodes by the protobuf type discriminator', () => {
    const found = findByType(decoded.tree, /ReplaceComponent/);
    expect(found[0]?.componentKey).toBe('profileCardsExperienceOnlyslug');
  });

  it('builds absolute image URLs sorted smallest-first', () => {
    const [asset] = collectImageAssets(decoded.tree);
    expect(asset?.assetUrn).toBe('urn:li:digitalmediaAsset:D4E03AQFTDoIx1A2FYA');
    expect(asset?.renditions.map((r) => r.width)).toEqual([100, 400]);
    const expectedUrl =
      'https://media.licdn.com/dms/image/v2/D4E03AQFTDoIx1A2FYA/photo-400_400/x?e=1';
    expect(asset?.renditions[1]?.url).toBe(expectedUrl);
  });
});
