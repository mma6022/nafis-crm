import { executeChanges, queryRow } from "./crm-db";

// Both user settings and PBX reports use voip_extensions; no second mapping.
// Invoke within the surrounding user-create/update transaction.
export function saveUserVoipExtension(userId: number, value: string | null, actorId: number) {
  const extension = value?.trim() || null;
  if (extension && queryRow(
    "SELECT user_id FROM voip_extensions WHERE extension=? AND user_id<>?", [extension, userId],
  )) throw new Error("voip_extension_conflict");
  executeChanges(
    `INSERT INTO voip_extensions(user_id,extension,authorization_username,updated_at,updated_by_user_id)
     VALUES(?,?,NULL,?,?) ON CONFLICT(user_id) DO UPDATE SET
     extension=excluded.extension,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`,
    [userId, extension, new Date().toISOString(), actorId],
  );
}