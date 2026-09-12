import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "web",
    environment: process.env.APP_ENV ?? "development",
    release: process.env.APP_RELEASE ?? "dev",
    time: new Date().toISOString(),
  });
}
