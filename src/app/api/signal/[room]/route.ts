const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const store = new Map<
  string,
  { sdp: string; timer: ReturnType<typeof setTimeout> }
>();

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  const resolvedParams = await params;
  const { role, sdp } = (await request.json()) as { role: string; sdp: string };
  const key = `${resolvedParams.room}:${role}`;

  const existing = store.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => store.delete(key), 30_000);
  store.set(key, { sdp, timer });

  return Response.json({ ok: true }, { headers: corsHeaders });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  const resolvedParams = await params;
  const url = new URL(request.url);
  const role = url.searchParams.get("role");
  const key = `${resolvedParams.room}:${role}`;
  const entry = store.get(key);

  if (entry) {
    clearTimeout(entry.timer);
    store.delete(key);
    return Response.json({ sdp: entry.sdp }, { headers: corsHeaders });
  }

  return Response.json({ sdp: null }, { headers: corsHeaders });
}
