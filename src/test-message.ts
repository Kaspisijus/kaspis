#!/usr/bin/env node

/**
 * Inject a fake WhatsApp message into messages.db for testing.
 * Usage: node dist/test-message.js "Reisai LBK608"
 *        node dist/test-message.js "Reisas 5268" --user Vilius
 */

import "dotenv/config";
import initSqlJs from "sql.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(
  __dirname, "..", "whatsapp-mcp", "whatsapp-bridge", "store", "messages.db"
);

// Parse allowed users from env
const users = (process.env.ALLOWED_WHATSAPP_USERS ?? "")
  .split(",")
  .map((e) => {
    const [lid, name] = e.trim().split(":");
    return { lid, name };
  });

// Parse CLI args
const args = process.argv.slice(2);
let message = "";
let userName = users[0]?.name ?? "Mantas"; // default to first user

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--user" && args[i + 1]) {
    userName = args[++i];
  } else {
    message = args[i];
  }
}

if (!message) {
  console.error("Usage: node dist/test-message.js \"<message>\" [--user <Name>]");
  console.error(`Available users: ${users.map((u) => u.name).join(", ")}`);
  process.exit(1);
}

const user = users.find((u) => u.name.toLowerCase() === userName.toLowerCase());
if (!user) {
  console.error(`User "${userName}" not in allowed list. Available: ${users.map((u) => u.name).join(", ")}`);
  process.exit(1);
}

const sender = user.lid;
const chatJid = `${sender}@lid`;
const id = randomUUID();
const timestamp = new Date().toISOString();

const SQL = await initSqlJs();
const buf = fs.readFileSync(DB_PATH);
const db = new SQL.Database(buf);

// Ensure chat exists
db.run(
  "INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)",
  [chatJid, user.name, timestamp]
);

// Insert message
db.run(
  `INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename, url)
   VALUES (?, ?, ?, ?, ?, 0, '', '', '')`,
  [id, chatJid, sender, message, timestamp]
);

// Write back
const data = db.export();
fs.writeFileSync(DB_PATH, Buffer.from(data));
db.close();

console.log(`✓ Injected message as ${user.name} (${sender}): "${message}"`);
console.log(`  ID: ${id} | Chat: ${chatJid} | Time: ${timestamp}`);
