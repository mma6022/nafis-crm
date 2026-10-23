import { EventEmitter } from "node:events";
const events = new EventEmitter();
events.setMaxListeners(1000);
export function notifyCallReport(expertUserId: number | null) { events.emit("changed", expertUserId); }
export function subscribeCallReports(listener: (expertUserId: number | null) => void) {
  events.on("changed", listener);
  return () => { events.off("changed", listener); };
}
