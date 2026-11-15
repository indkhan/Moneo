import { randomUUID } from "node:crypto";
import type { ComponentProps } from "react";
import { WealthFields } from "./wealth-fields";

export function WealthForm(props: Omit<ComponentProps<typeof WealthFields>, "itemId" | "requestId">) {
  return <WealthFields {...props} itemId={props.item?.id ?? randomUUID()} requestId={randomUUID()} />;
}
