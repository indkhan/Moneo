import { randomUUID } from "node:crypto";
import type { ComponentProps } from "react";
import { WealthFields } from "./wealth-fields";

/** Fresh ids each render, so the next save after a refresh is a new operation; a refused save does not refresh and retries with its own. */
export function WealthForm(props: Omit<ComponentProps<typeof WealthFields>, "itemId" | "requestId">) {
  return <WealthFields {...props} itemId={props.item?.id ?? randomUUID()} requestId={randomUUID()} />;
}
