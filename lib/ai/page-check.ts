import { Script } from "node:vm";

const INLINE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const isJavaScript = (attributes: string) => !/\bsrc\s*=/i.test(attributes)
  && (!/\btype\s*=/i.test(attributes) || /\btype\s*=\s*["']?(text\/javascript|application\/javascript)["']?/i.test(attributes));

/**
 * Syntax errors in a generated page's inline scripts. One broken script stops the whole page from drawing, so a page
 * that fails this is never saved. Scripts are only compiled, never run.
 */
export function pageScriptErrors(html: string) {
  return [...html.matchAll(INLINE)].filter(match => isJavaScript(match[1])).flatMap((match, index) => {
    try { new Script(match[2], { filename: `script-${index + 1}.js` }); return []; }
    catch (error) {
      const line = /script-\d+\.js:(\d+)/.exec(error instanceof Error ? error.stack ?? "" : "")?.[1];
      return [`Script ${index + 1}${line ? `, line ${line}` : ""}: ${error instanceof Error ? error.message : String(error)}`];
    }
  });
}
