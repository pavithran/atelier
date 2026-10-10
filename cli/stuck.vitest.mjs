// Keep task tests within cli/** while using the project's local Worker pool.
import config from '../vitest.config.ts';
export default { ...config, test: { ...config.test, include: ['cli/stuck.worker.test.mjs'] } };
