// Status waits for submitted tasks whose current head has no review request.
export function submissionWaits(items, project) {
  return (items ?? []).filter(i => i.state === "submitted" && i.head && i.reviewAskedHead === null)
    .map(i => ({ id: i.id, head: i.head, reason: "submitted with no review asked for this head", command: `atelier land ${i.id} --reviewer H/M --project ${project}` }));
}
