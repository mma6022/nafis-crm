-- SMS-OFF-71 live safety triggers (installed on live 2026-10-28, v2). SINGLE-QUOTED string literals only:
-- node:sqlite (Node 22) rejects double-quoted strings ("no such column"), which broke every insert into reminder_sms_deliveries
-- for ~8 minutes with the v1 triggers. Tested by scripts/reminder-workflow-fixture.ts (inserts/updates with these triggers present).
CREATE TRIGGER IF NOT EXISTS sms_off71_block AFTER INSERT ON reminder_sms_deliveries
 WHEN NEW.status IN ('pending','blocked') BEGIN
 UPDATE reminder_sms_deliveries SET status='rejected',error_code='in_app_only',next_attempt_at=NULL WHERE reminder_id=NEW.reminder_id; END;
CREATE TRIGGER IF NOT EXISTS sms_off71_block_upd AFTER UPDATE OF status ON reminder_sms_deliveries
 WHEN NEW.status IN ('pending','blocked') BEGIN
 UPDATE reminder_sms_deliveries SET status='rejected',error_code='in_app_only',next_attempt_at=NULL WHERE reminder_id=NEW.reminder_id; END;
