import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  const resolvedParams = await params;
  const { role, sdp } = (await request.json()) as { role: string; sdp: string };
  await redis.set(`${resolvedParams.room}:${role}`, sdp, { ex: 30 });
  return Response.json({ ok: true }, { headers: corsHeaders });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  const resolvedParams = await params;
  const role = new URL(request.url).searchParams.get("role");
  const key = `${resolvedParams.room}:${role}`;
  const sdp = await redis.get<string>(key);
  if (sdp) await redis.del(key);
  return Response.json({ sdp: sdp ?? null }, { headers: corsHeaders });
}
