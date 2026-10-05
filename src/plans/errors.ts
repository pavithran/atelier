export const PLAN_ERROR_LIMIT = 50;

export function planErrors() {
  const errors: string[] = [];
  let count = 0;
  return {
    push(error: string) {
      count++;
      if (errors.length < PLAN_ERROR_LIMIT) errors.push(error);
    },
    result(): string[] {
      return count > PLAN_ERROR_LIMIT
        ? [...errors.slice(0, PLAN_ERROR_LIMIT - 1), `and ${count - PLAN_ERROR_LIMIT + 1} more errors`]
        : errors.slice();
    },
  };
}
