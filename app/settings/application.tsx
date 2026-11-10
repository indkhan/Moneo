import { headers } from "next/headers";
import { applicationState } from "@/lib/application";
import { localApplicationRequest } from "@/scripts/application-state.mjs";
import { ApplicationCard } from "./application-card";

export async function ApplicationSection() {
  return <ApplicationCard initial={await applicationState(localApplicationRequest(await headers()))} />;
}
