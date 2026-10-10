import config from "../vitest.config.ts";
// The task's test files stay within its src/** and cli/** scope.
export default { ...config, test: { ...config.test, include: ["src/runner-token.spec.mjs"] } };
