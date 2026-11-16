export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startNodeRuntime } = await import("./instrumentation-node");
  await startNodeRuntime();
}
