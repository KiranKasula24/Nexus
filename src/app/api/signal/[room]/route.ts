import { Redis } from "@upstash/redis";

const SIGNAL_TTL_SECONDS = 180;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown server error";
}

function resolveRedisEnv(): { url: string; token: string; source: string } {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const kvUrl = process.env.KV_REST_API_URL?.trim();
  const kvToken = process.env.KV_REST_API_TOKEN?.trim();

  if (upstashUrl && upstashToken) {
    return {
      url: upstashUrl,
      token: upstashToken,
      source: "UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN",
    };
  }

  if (kvUrl && kvToken) {
    return {
      url: kvUrl,
      token: kvToken,
      source: "KV_REST_API_URL/KV_REST_API_TOKEN",
    };
  }

  const configured = [
    upstashUrl ? "UPSTASH_REDIS_REST_URL" : null,
    upstashToken ? "UPSTASH_REDIS_REST_TOKEN" : null,
    kvUrl ? "KV_REST_API_URL" : null,
    kvToken ? "KV_REST_API_TOKEN" : null,
  ].filter(Boolean);

  throw new Error(
    configured.length > 0
      ? `Incomplete Redis env configuration. Provide a full pair of either UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL/KV_REST_API_TOKEN. Currently set: ${configured.join(", ")}`
      : "Missing Redis env configuration. Provide UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL/KV_REST_API_TOKEN.",
  );
}

function getRedis(): Redis {
  const { url, token } = resolveRedisEnv();
  return new Redis({ url, token });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  try {
    const resolvedParams = await params;
    const redis = getRedis();
    const { role, sdp } = (await request.json()) as {
      role: string;
      sdp: string;
    };

    if ((role !== "offer" && role !== "answer") || !sdp) {
      return Response.json(
        { ok: false, error: "Missing or invalid role/sdp." },
        { status: 400, headers: corsHeaders },
      );
    }

    await redis.set(`${resolvedParams.room}:${role}`, sdp, {
      ex: SIGNAL_TTL_SECONDS,
    });
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return Response.json(
      { ok: false, error: errorMessage(error) },
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
    const redis = getRedis();
    const requestedRole = new URL(request.url).searchParams.get("role");

    if (requestedRole === "offer" || requestedRole === "answer") {
      const key = `${resolvedParams.room}:${requestedRole}`;
      const sdp = await redis.get<string>(key);
      return Response.json(
        { sdp: sdp ?? null, role: requestedRole },
        { headers: corsHeaders },
      );
    }

    const offer = await redis.get<string>(`${resolvedParams.room}:offer`);
    if (offer) {
      return Response.json(
        { sdp: offer, role: "offer" },
        { headers: corsHeaders },
      );
    }

    const answer = await redis.get<string>(`${resolvedParams.room}:answer`);
    if (answer) {
      return Response.json(
        { sdp: answer, role: "answer" },
        { headers: corsHeaders },
      );
    }

    return Response.json({ sdp: null, role: null }, { headers: corsHeaders });
  } catch (error) {
    return Response.json(
      { sdp: null, role: null, error: errorMessage(error) },
      { status: 500, headers: corsHeaders },
    );
  }
}
