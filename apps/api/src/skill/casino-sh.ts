// The official script, casino.sh (casino-api skill: A23), served at
// GET /casino.sh with this deployment's address as its default CASINO_URL.
import script from './casino.sh?raw' with { type: 'text' };

// Bump on every change agents should download again.
export const CASINO_SH_VERSION = '2026-10-20.1';

export const renderCasinoSh = (baseUrl: string): string =>
  script
    .replace('__CASINO_SH_VERSION__', CASINO_SH_VERSION)
    .replace('__CASINO_URL__', baseUrl);
