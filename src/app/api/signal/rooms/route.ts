import {
  createSignalRoom,
  corsHeaders,
  errorResponse,
  getRedis,
  optionsResponse,
  SIGNAL_TTL_SECONDS,
} from "../_shared";

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: Request) {
  try {
    const { offerSdp } = (await request.json()) as {
      offerSdp?: string;
    };

    if (!offerSdp) {
      return Response.json(
        { ok: false, code: "OFFER_MISSING", error: "Missing offer SDP." },
        { status: 400, headers: corsHeaders },
      );
    }

    const room = await createSignalRoom(getRedis(), offerSdp);
    return Response.json(
      {
        ok: true,
        room: room.room,
        expiresAt: room.expiresAt,
        ttlSeconds: SIGNAL_TTL_SECONDS,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
