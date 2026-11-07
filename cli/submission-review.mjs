// Shared by status and a pulse consumer reading the current task snapshot.
export function submissionWaits(items, project) {
  return (items ?? []).filter(i => i.state === "submitted" && i.head && i.reviewAskedHead === null)
    .map(i => ({ id: i.id, head: i.head, reason: "submitted with no review asked for this head", command: `atelier land ${i.id} --reviewer H/M --project ${project}` }));
}

export function wakesForSubmission(event, items) {
  if (event.kind !== "item.submitted") return false;
  return (items ?? []).some(i => i.state === "submitted" && i.id === event.itemId && i.head === event.data?.head && i.reviewAskedHead !== i.head);
}
