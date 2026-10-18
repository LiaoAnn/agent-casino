// What apps/web reads from its environment (src/data.ts).
interface ImportMetaEnv {
  // The api under `vite dev`; default http://127.0.0.1:8787.
  readonly VITE_API_URL?: string;
  // '1' serves the contract's fake data instead (the Playwright tests).
  readonly VITE_FAKE_DATA?: string;
}

declare module 'cloudflare:workers' {
  // The bindings of wrangler.jsonc.
  export const env: { API: Fetcher };
}
