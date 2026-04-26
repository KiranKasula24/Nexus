import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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
  try {
    const resolvedParams = await params;
    const { role, sdp } = (await request.json()) as {
      role: string;
      sdp: string;
    };

    if (!role || !sdp) {
      return Response.json(
        { ok: false, error: "Missing role or sdp." },
        { status: 400, headers: corsHeaders },
      );
    }

    await redis.set(`${resolvedParams.room}:${role}`, sdp, { ex: 30 });
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown server error";
    return Response.json(
      { ok: false, error: message },
      { status: 500, headers: corsHeaders },
    );
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  try {
    const resolvedParams = await params;
    const role = new URL(request.url).searchParams.get("role");

    if (!role) {
      return Response.json(
        { sdp: null, error: "Missing role query parameter." },
        { status: 400, headers: corsHeaders },
      );
    }

    const key = `${resolvedParams.room}:${role}`;
    const sdp = await redis.get<string>(key);
    if (sdp) await redis.del(key);
    return Response.json({ sdp: sdp ?? null }, { headers: corsHeaders });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown server error";
    return Response.json(
      { sdp: null, error: message },
      { status: 500, headers: corsHeaders },
    );
  }
}
