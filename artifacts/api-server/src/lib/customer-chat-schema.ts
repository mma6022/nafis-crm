import { crmDb, queryRows } from "./crm-db";
import { installCustomerChatHistory } from "./customer-chat-history";

// Chat can be published independently of portal intake/allocation changes.
crmDb.exec(`
CREATE TABLE IF NOT EXISTS customer_chat_messages(
 id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),
 sender_type TEXT NOT NULL CHECK(sender_type IN ('customer','staff')),sender_id INTEGER NOT NULL,
 sender_name TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL,
 object_path TEXT,file_name TEXT,mime_type TEXT,file_size INTEGER,
 client_id TEXT NOT NULL,content_hash TEXT,created_at TEXT NOT NULL,
 UNIQUE(customer_id,sender_type,sender_id,client_id));
CREATE INDEX IF NOT EXISTS idx_customer_chat_history ON customer_chat_messages(customer_id,id);
CREATE TABLE IF NOT EXISTS customer_chat_reads(
 customer_id INTEGER NOT NULL,reader_type TEXT NOT NULL,reader_id INTEGER NOT NULL,
 last_message_id INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(customer_id,reader_type,reader_id));
CREATE TABLE IF NOT EXISTS customer_chat_presence(
 actor_type TEXT NOT NULL,actor_id INTEGER NOT NULL,last_seen TEXT NOT NULL,
 PRIMARY KEY(actor_type,actor_id));
`);
if (!queryRows<{ name: string }>("PRAGMA table_info(customer_chat_messages)").some(c => c.name === "content_hash")) {
  crmDb.exec("ALTER TABLE customer_chat_messages ADD COLUMN content_hash TEXT");
}
installCustomerChatHistory(crmDb);
