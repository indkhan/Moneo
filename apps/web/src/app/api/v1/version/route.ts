import { NextResponse } from "next/server";
import { getVersionInfo } from "@/lib/release";

export function GET() {
  return NextResponse.json(getVersionInfo());
}
