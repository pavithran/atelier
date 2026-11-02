export const landingStartsAtAcceptedHead = (local, accepted) => !!accepted && local === accepted;

export async function catchUp(io) {
  if (!io.project?.path || io.project.fresh) throw new Error('catch-up needs a registered checkout with full history');
  if (!io.accept?.length) throw new Error('give the developer’s acceptance criteria with --accept');
  if (!io.builder || !io.reviewer || io.builder.toLowerCase() === io.reviewer.toLowerCase()) throw new Error('name a builder and an independent reviewer');
  const state = await io.inspect();
  if (!state.clean || state.branch !== io.project.branch) throw new Error('catch-up needs a clean checkout on the registered branch');
  if (!state.descendant || state.head === state.baseline) throw new Error('the checkout must be strictly ahead of the project by fast-forward commits');
  const { id } = await io.create(state);
  const dir = await io.claim(id);
  await io.carry(dir, state.head);
  await io.finish(dir, id);
  while (!await io.land(id)) await io.pause(id);
  io.print(`${id} caught up and landed at ${state.head}.`);
  return id;
}
