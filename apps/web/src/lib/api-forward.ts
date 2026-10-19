// Pass the original public request and the API response through unchanged.
export async function forwardApi(
  request: Request,
  fetchApi: (request: Request) => Promise<Response>,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  return pathname === '/skill.md' ||
    pathname === '/casino.sh' ||
    pathname.startsWith('/v1/')
    ? fetchApi(request)
    : null;
}
