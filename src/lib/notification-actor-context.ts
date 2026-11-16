import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

// Request-local: overlapping asynchronous requests must never share an actor.
const actors = new AsyncLocalStorage<string>();
export function withNotificationActor<T>(actor: string, work: () => T): T {
  return actors.run(actor, work);
}
export function registerNotificationActorFunction(db: DatabaseSync) {
  db.function("site_notification_actor", () => actors.getStore() ?? "system");
}
