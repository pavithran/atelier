// Ancestry-ordered batches shared by initial pushes and move-host. Outside
// parents exclude exactly the history outside a batch, including merge sides.
export function* historyRanges(rows) {
  const step = 400;
  for (let i = 0; i < rows.length; i += step) {
    const batch = rows.slice(i, i + step);
    const tips = batch.map(([hash]) => hash);
    const inside = new Set(tips);
    const base = [...new Set(batch.flatMap(([, ...parents]) => parents).filter((p) => !inside.has(p)))];
    yield { tips, base };
  }
}
