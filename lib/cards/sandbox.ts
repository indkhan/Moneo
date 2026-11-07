import { transform } from "sucrase";

export { runCard, type CardNode } from "./engine";

/** Compiles card TSX (written by the designer model) to a plain script; throws with the syntax error. */
export function compileCard(source: string) {
  return transform(source, { transforms: ["typescript", "jsx", "imports"], jsxPragma: "h", jsxFragmentPragma: "Fragment", production: true }).code;
}
