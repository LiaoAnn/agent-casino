// `pnpm db:generate` writes migrations into the folder wrangler.jsonc's D1
// binding applies from (`wrangler d1 migrations apply agent-casino --local`).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
});
