// atelier catch-up. Its forms, flags and help are declared in src/usage/commands/catch-up.ts.
import { fileURLToPath } from 'node:url';
import { catchUp } from '../catch-up.mjs';
import { runCommand } from '../ship.mjs';
import { I, OWNER, P, args, call, cfg, claimWorkspace, die, fieldsArg, git, project } from '../atelier.mjs';

export default async function catchUpCommand() {
  const name = project(), p = cfg.projects?.[name];
  const fields = fieldsArg('catch-up');
  const builder = args.builder, reviewer = args.reviewer;
  const child = async (argv, cwd, pending = false, submittedId = null) => {
    const r = await runCommand([process.execPath, fileURLToPath(new URL('../atelier.mjs', import.meta.url)), ...argv, '--project', name], {
      cwd, env: { ...process.env, ATELIER_LAND_POOL: '1' }, timeoutMs: 60 * 60_000,
    });
    if (pending && r.status === 75) return false;
    if (submittedId && r.status === 3) {
      const d = await call('GET', I(name, submittedId), undefined, OWNER);
      if (d.item.state === 'submitted' && d.item.head === git(['rev-parse', 'HEAD'], { cwd })) return true;
    }
    if (!r.passed) throw new Error(`catch-up stopped; the task and checkout are preserved:\n${r.output}`);
    return true;
  };
  try {
    await catchUp({
      project: p, builder, reviewer, accept: fields.accept,
      inspect: async () => {
        const baseline = (await call('GET', `${P(name)}/baseline-head`, undefined, OWNER)).head;
        return {
          baseline, head: git(['rev-parse', 'HEAD'], { cwd: p.path }),
          branch: git(['branch', '--show-current'], { cwd: p.path }),
          clean: !git(['status', '--porcelain'], { cwd: p.path }),
          descendant: !!baseline && git(['merge-base', '--is-ancestor', baseline, 'HEAD'], { cwd: p.path, allowFail: true }).status === 0,
        };
      },
      create: state => call('POST', `${P(name)}/items`, {
        ...fields, title: typeof args.title === 'string' ? args.title : `Catch up ${name}`,
        brief: fields.brief ?? `Carry direct commits from ${state.baseline} through ${state.head} through checks, independent review and landing.`,
      }, OWNER),
      claim: async id => {
        console.log(`Catch-up task: ${id}. Resume with atelier land ${id} --project ${name} --reviewer ${reviewer} after resolving any failure.`);
        return (await claimWorkspace(name, id, builder, null)).dir;
      },
      carry: async (dir, head) => {
        if (git(['status', '--porcelain'], { cwd: dir })) throw new Error('the claimed workspace is dirty');
        git(['fetch', '--quiet', '--', p.path, head], { cwd: dir });
        git(['merge', '--ff-only', head], { cwd: dir });
      },
      finish: (dir, id) => child(['done', 'Carry the checkout’s direct commits', '--as', builder], dir, false, id),
      land: async id => {
        const d = await call('GET', I(name, id), undefined, OWNER);
        if (d.item.state === 'merged') return true;
        if (d.item.state === 'claimed') throw new Error(`${id} returned to its builder; resolve the review findings before resuming`);
        return child(['land', id, '--reviewer', reviewer], p.path, true);
      },
      pause: async () => new Promise(resolve => setTimeout(resolve, 5000)),
      print: line => console.log(line),
    });
  } catch (error) { die(error.message); }
}
