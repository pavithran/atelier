// t620: the live copy of a ship step's output, cut of the secrets ship redacts.
// One stream per pipe per step, made when the step starts and dropped when it
// ends. A secret can arrive split across two chunks, so the stream holds back
// the last (longest secret - 1) characters until the next chunk or end(). If
// ship dies, what is held back is lost, never printed raw.

const MARK = "[redacted]";

export function liveRedactor(write, secrets) {
  const list = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  const hold = list.length ? list[0].length - 1 : 0;
  let pending = "";
  // Writes the text before `limit`, secrets replaced by the mark; a secret that
  // starts before `limit` is cut whole, so it is never shown in part.
  function emit(limit) {
    let i = 0, shown = "";
    while (i < limit && i < pending.length) {
      const secret = list.find((s) => pending.startsWith(s, i));
      if (secret) { shown += MARK; i += secret.length; } else shown += pending[i++];
    }
    pending = pending.slice(i);
    if (shown) write(shown);
  }
  return {
    write(chunk) { pending += chunk; emit(pending.length - hold); },
    end() { emit(Infinity); },
  };
}
