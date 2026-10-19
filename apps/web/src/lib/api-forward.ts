// The API's text files: the manual, the script and the kit (A24).
const API_FILES = new Set([
  '/skill.md',
  '/casino.sh',
  '/llms.txt',
  '/skills/agent-casino/SKILL.md',
  '/skills/agent-casino/scripts/casino.sh',
  '/skills/agent-casino-holdem/SKILL.md',
]);

// Pass the original public request and the API response through unchanged.
export async function forwardApi(
  request: Request,
  fetchApi: (request: Request) => Promise<Response>,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  return API_FILES.has(pathname) || pathname.startsWith('/v1/')
    ? fetchApi(request)
    : null;
}
