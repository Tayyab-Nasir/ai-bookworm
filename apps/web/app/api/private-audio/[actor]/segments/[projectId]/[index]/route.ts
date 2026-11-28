import type { NextRequest } from "next/server";
import { privateAudioSegment } from "../../../../../../../lib/private-audio-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ actor: string; projectId: string; index: string }> }) {
  return privateAudioSegment(request, await context.params);
}
