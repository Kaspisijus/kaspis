import "dotenv/config";
import initSqlJs from "sql.js";
import fs from "fs";

async function main() {
  const SQL = await initSqlJs();

  // Whatsmeow store - find LIDs for our authorized users
  const buf2 = fs.readFileSync("whatsapp-mcp/whatsapp-bridge/store/whatsapp.db");
  const db2 = new SQL.Database(buf2);

  // Check lid_map table
  console.log("=== LID MAP ===");
  const lidMap = db2.exec("SELECT * FROM whatsmeow_lid_map LIMIT 30");
  if (lidMap[0]) {
    console.log("Columns:", lidMap[0].columns);
    lidMap[0].values.forEach((r) => console.log("  ", r.join(" | ")));
  }

  // Search contacts for our phone numbers
  console.log("\n=== SEARCH 37067536696 (Mantas) ===");
  const c1 = db2.exec("SELECT their_jid, first_name, full_name, push_name FROM whatsmeow_contacts WHERE their_jid LIKE '%37067536696%'");
  if (c1[0]) c1[0].values.forEach((r) => console.log("  ", r.join(" | ")));
  else console.log("  Not found in contacts");

  console.log("\n=== SEARCH 37060889319 (Vilius) ===");
  const c2 = db2.exec("SELECT their_jid, first_name, full_name, push_name FROM whatsmeow_contacts WHERE their_jid LIKE '%37060889319%'");
  if (c2[0]) c2[0].values.forEach((r) => console.log("  ", r.join(" | ")));
  else console.log("  Not found in contacts");

  // Check who sent the test message (86719735005297)
  console.log("\n=== LID MAP for 86719735005297 ===");
  const lid1 = db2.exec("SELECT * FROM whatsmeow_lid_map WHERE lid LIKE '%86719735005297%' OR pn LIKE '%86719735005297%'");
  if (lid1[0]) lid1[0].values.forEach((r) => console.log("  ", r.join(" | ")));
  else console.log("  Not found");

  // Find LIDs for our authorized users
  console.log("\n=== LID for 37067536696 (Mantas) ===");
  const l2 = db2.exec("SELECT * FROM whatsmeow_lid_map WHERE pn = '37067536696'");
  if (l2[0]) l2[0].values.forEach((r) => console.log("  ", r.join(" | ")));
  else console.log("  Not found in lid_map");

  console.log("\n=== LID for 37060889319 (Vilius) ===");
  const l3 = db2.exec("SELECT * FROM whatsmeow_lid_map WHERE pn = '37060889319'");
  if (l3[0]) l3[0].values.forEach((r) => console.log("  ", r.join(" | ")));
  else console.log("  Not found in lid_map");

  // Also search contacts by push_name
  console.log("\n=== SEARCH by name Mantas ===");
  const c3 = db2.exec("SELECT their_jid, first_name, full_name, push_name FROM whatsmeow_contacts WHERE push_name LIKE '%Mantas%' OR full_name LIKE '%Mantas%'");
  if (c3[0]) c3[0].values.forEach((r) => console.log("  ", r.join(" | ")));

  console.log("\n=== SEARCH by name Vilius ===");
  const c4 = db2.exec("SELECT their_jid, first_name, full_name, push_name FROM whatsmeow_contacts WHERE push_name LIKE '%Vilius%' OR full_name LIKE '%Vilius%'");
  if (c4[0]) c4[0].values.forEach((r) => console.log("  ", r.join(" | ")));

  db2.close();
}

main();
