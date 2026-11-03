// Only reads and claim renewals may use this: repeating other writes can
// apply them twice. Each attempt must create its own timeout signal.
export async function transientRead(attempt, signal) {
  for (let retry = 0; ; retry++) {
    try {
      const result = await attempt();
      if (retry === 2 || ![408, 429, 500, 502, 503, 504].includes(result?.status)) return result;
      await result.body?.cancel();
    } catch (error) {
      const transient = error?.name === "TimeoutError" || error?.message === "fetch failed";
      if (retry === 2 || signal?.aborted || !transient) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    signal?.throwIfAborted();
  }
}
