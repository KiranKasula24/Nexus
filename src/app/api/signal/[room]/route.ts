import {
  corsHeaders,
  errorResponse,
  getRedis,
  optionsResponse,
  publishSignal,
  requireRoomRecord,
  signalKey,
} from "../_shared";

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  try {
    const resolvedParams = await params;
    const { role, sdp } = (await request.json()) as {
      role?: "offer" | "answer";
      sdp?: string;
    };

    if ((role !== "offer" && role !== "answer") || !sdp) {
      return Response.json(
        { ok: false, error: "Missing or invalid role/sdp." },
        { status: 400, headers: corsHeaders },
      );
    }

    const room = await publishSignal(getRedis(), resolvedParams.room, role, sdp);
    return Response.json(
      {
        ok: true,
        room: room.room,
        role,
        status: room.status,
        expiresAt: room.expiresAt,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  try {
    const resolvedParams = await params;
    const requestedRole = new URL(request.url).searchParams.get("role");

    if (requestedRole !== "offer" && requestedRole !== "answer") {
      return Response.json(
        {
          ok: false,
          code: "ROLE_REQUIRED",
          error: "Query parameter role=offer|answer is required.",
        },
        { status: 400, headers: corsHeaders },
      );
    }

    const redis = getRedis();
    const room = await requireRoomRecord(redis, resolvedParams.room);
    const sdp = await redis.get<string>(signalKey(room.room, requestedRole));

    return Response.json(
      {
        ok: true,
        room: room.room,
        role: requestedRole,
        status: room.status,
        expiresAt: room.expiresAt,
        sdp: sdp ?? null,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
