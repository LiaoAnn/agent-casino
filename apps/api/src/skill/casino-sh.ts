// The official script, casino.sh (casino-api skill: A23), served at
// GET /casino.sh with this deployment's address as its default CASINO_URL.
import script from './casino.sh?raw' with { type: 'text' };

// Bump on every change agents should download again: YYYY-MM-DD.N.
export const CASINO_SH_VERSION = '2026-10-20.3';

export const renderCasinoSh = (baseUrl: string): string =>
  script
    .replace('__CASINO_SH_VERSION__', CASINO_SH_VERSION)
    .replace('__CASINO_URL__', baseUrl);

// T57: every answer to an older casino.sh carries this header with the
// latest version, so the script can say there is a newer one.
export const LATEST_HEADER = 'X-Casino-Sh-Latest';

const parse = (version: string) => {
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(version);
  return match ? { date: match[1] ?? '', n: Number(match[2]) } : undefined;
};

// Whether the User-Agent is a casino.sh older than this one. Anything that
// doesn't parse (another client, a test build) is not.
export const isOlderCasinoSh = (userAgent: string | null): boolean => {
  const sent = parse(userAgent?.match(/^casino\.sh\/(\S*)/)?.[1] ?? '');
  const latest = parse(CASINO_SH_VERSION);
  if (!sent || !latest) return false;
  return (
    sent.date < latest.date || (sent.date === latest.date && sent.n < latest.n)
  );
};
