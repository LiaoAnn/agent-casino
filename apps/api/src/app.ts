// Plain request handling, kept free of `cloudflare:workers` imports so it can
// be unit tested in Node.
export function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/health') {
    return Response.json({ ok: true });
  }
  return Response.json(
    {
      error: {
        code: 'not_found',
        message: `No route for ${request.method} ${pathname}.`,
      },
    },
    { status: 404 },
  );
}
