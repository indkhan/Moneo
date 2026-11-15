import { transform } from "sucrase";

export { runCard, type CardNode } from "./engine";

export function compileCard(source: string) {
  return transform(source, { transforms: ["typescript", "jsx", "imports"], jsxPragma: "h", jsxFragmentPragma: "Fragment", production: true }).code;
}
