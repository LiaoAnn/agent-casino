// `import text from './x.md?raw' with { type: 'text' }`: Vitest (Vite) reads
// the `?raw` suffix and wrangler (esbuild) the `type: 'text'` attribute; both
// give the file's text.
declare module '*.md?raw' {
  const text: string;
  export default text;
}
