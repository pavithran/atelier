import { slotProcesses } from "../../cli/load.mjs";

// Skip only denied process inspection, not a broken parser or runtime.
// Production continues to refuse admission when it cannot inspect ownership.
export function canInspectSlots(t) {
  try { slotProcesses(); return true; }
  catch (error) {
    if (!/EPERM|EACCES|operation not permitted|permission denied/i.test(error.message)) throw error;
    t.skip(`process inspection unavailable: ${error.message}`);
    return false;
  }
}
