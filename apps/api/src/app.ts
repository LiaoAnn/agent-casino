// Plain request handling, kept free of `cloudflare:workers` imports so it can
// be unit tested in Node. The error body format comes with the contract (T03).
export function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/health') {
    return Response.json({ ok: true });
  }
  return new Response(null, { status: 404 });
}
