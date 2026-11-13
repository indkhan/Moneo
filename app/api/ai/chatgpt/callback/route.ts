import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { ChatGPTError, finishSignIn } from "@/lib/ai/chatgpt";
import { getEnv } from "@/lib/env";
import { connectionReturn } from "@/lib/desktop-auth-return";

// ChatGPT redirects here (on 127.0.0.1, as OpenAI requires) after the owner signs in.
export async function GET(request: Request) {
  const back = (result: string) => connectionReturn(getEnv().NEXT_PUBLIC_APP_URL, `/settings?chatgpt=${encodeURIComponent(result)}#ai-access`);
  try { await requireWorkspace(); } catch { return NextResponse.redirect(new URL("/setup", request.url), 303); }
  try {
    await finishSignIn(new URL(request.url).searchParams);
    return back("connected");
  } catch (error) {
    return back(error instanceof ChatGPTError ? error.message : "ChatGPT sign-in failed. Try again.");
  }
}
