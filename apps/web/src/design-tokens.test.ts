import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pages and components colour only with the design tokens of styles.css
// (web-design skill): no hex codes, no colour functions, no Tailwind palette.

const src = join(import.meta.dirname);

// The `--color-*` names styles.css defines, e.g. `navy-800`, `red-400`.
const tokens = new Set(
  [
    ...readFileSync(join(src, 'styles.css'), 'utf8').matchAll(
      /--color-([a-z0-9-]+):/g,
    ),
  ].map(m => m[1] as string),
);

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe';

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
// `bg-zinc-400`, `text-red-500/80`, `border-white`: a Tailwind colour name,
// with a shade or as black/white.
const PALETTE_CLASS = new RegExp(
  `(?<![\\w-])[a-z]+(?:-[a-z]+)*-((?:${PALETTE})-\\d{2,3}|black|white)(?![\\w-])`,
  'g',
);

function hardcodedColors(source: string): string[] {
  const found = [
    ...[...source.matchAll(HEX)].map(m => m[0]),
    ...[...source.matchAll(COLOR_FUNCTION)].map(m => m[0]),
    ...[...source.matchAll(PALETTE_CLASS)]
      .filter(m => !tokens.has(m[1] as string))
      .map(m => m[0]),
  ];
  return found;
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });

describe('hardcodedColors', () => {
  it('finds hex codes, colour functions and Tailwind palette classes', () => {
    expect(
      hardcodedColors(
        `<p className="bg-zinc-400 text-red-500/80 border-white hover:text-blue-700 [color:#fff] [background:rgb(0_0_0)] fill-black">`,
      ),
    ).toEqual([
      '#fff',
      'rgb(',
      'bg-zinc-400',
      'border-white',
      'text-blue-700',
      'fill-black',
    ]);
  });

  it('accepts design tokens and non-colour utilities', () => {
    expect(tokens).toContain('navy-800');
    expect(tokens).toContain('red-400');
    expect(
      hardcodedColors(
        `<p className="bg-navy-800 text-red-400 text-mist border-gold-600/40 text-sm border-2 ring-ring z-10 grid-cols-2 gap-x-6 text-suit-heart">`,
      ),
    ).toEqual([]);
  });
});

describe.each(['routes', 'components'])('%s/ uses only design tokens', dir => {
  it.each(files(join(src, dir)).map(path => relative(src, path)))(
    '%s',
    path => {
      expect(hardcodedColors(readFileSync(join(src, path), 'utf8'))).toEqual(
        [],
      );
    },
  );
});
