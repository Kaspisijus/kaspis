#!/usr/bin/env node

/**
 * WhatsApp Polling Service for Brunas TMS
 *
 * Polls the WhatsApp bridge SQLite DB for new messages from authorized users,
 * parses TMS commands, executes them via BrunasApiClient, and replies via
 * the WhatsApp bridge HTTP API.
 */

import "dotenv/config";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import fs from "fs";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { BrunasApiClient } from "./brunas-api.js";

// ─── Config ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10);
const WHATSAPP_API = process.env.WHATSAPP_API_URL ?? "http://localhost:8080";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(
  __dirname,
  "..",
  "whatsapp-mcp",
  "whatsapp-bridge",
  "store",
  "messages.db"
);
const WHATSAPP_DB_PATH = path.resolve(
  __dirname,
  "..",
  "whatsapp-mcp",
  "whatsapp-bridge",
  "store",
  "whatsapp.db"
);

// ─── Allowed users ───────────────────────────────────────────────────

interface AllowedUser {
  phone: string;
  name: string;
}

function parseAllowedUsers(raw: string): AllowedUser[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const [phone, name] = entry.trim().split(":");
    return { phone: phone.replace("+", ""), name: name ?? phone };
  });
}

const ALLOWED_USERS = parseAllowedUsers(
  process.env.ALLOWED_WHATSAPP_USERS ?? ""
);

function isAuthorized(sender: string): AllowedUser | null {
  // sender in DB can be LID (e.g. "86719735005297") or phone (e.g. "37067536696")
  const clean = sender.replace("+", "").replace("@s.whatsapp.net", "").replace("@lid", "");
  return ALLOWED_USERS.find((u) => u.phone === clean) ?? null;
}

// ─── Brunas client (lazy) ────────────────────────────────────────────

let brunasClient: BrunasApiClient | null = null;

function getBrunas(): BrunasApiClient {
  if (!brunasClient) {
    const email = process.env.BRUNAS_EMAIL!;
    const password = process.env.BRUNAS_PASSWORD!;
    const clientUrl = process.env.BRUNAS_CLIENT_URL!;
    brunasClient = new BrunasApiClient(email, password, clientUrl);
  }
  return brunasClient;
}

// ─── Task type map ───────────────────────────────────────────────────

const TASK_TYPES: Record<number, string> = {
  0: "Unloading",
  1: "Fuel",
  2: "CarWash",
  3: "Service",
  5: "Loading",
};

// ─── Command parsing & execution ─────────────────────────────────────

interface ParsedCommand {
  type: "find_carriages" | "carriages_by_vehicle" | "find_drivers" | "find_vehicles" | "unknown";
  filters: Array<{ field: string; value: string | string[] | number[]; operator: string }>;
  quickFilter?: string[];
  pageSize: number;
  vehiclePlate?: string;
}

function parseCommand(text: string): ParsedCommand {
  const lower = text.toLowerCase().trim();

  // Find carriage by ID (e.g. "carriage 5268", "reisas 5268", "#5268")
  const carriageIdMatch = lower.match(
    /(?:carriage|reisas|reis(?:ą|a)|#)\s*(\d+)/
  );
  if (carriageIdMatch) {
    return {
      type: "find_carriages",
      filters: [
        {
          field: "prettyId",
          value: carriageIdMatch[1],
          operator: "contains",
        },
      ],
      pageSize: 5,
    };
  }

  // Find carriages (general)
  if (
    /carriage|reisas|reis(?:ą|a|ai|us)|krovinys|krovini|shipment|trip/i.test(
      lower
    )
  ) {
    // Check for status filters
    const statusMatch = lower.match(
      /(?:status|būsena)\s*[:=]?\s*(draft|confirmed|planned|inprogress|in progress|finished|invoiced|cancelled)/i
    );
    const filters: ParsedCommand["filters"] = [];
    if (statusMatch) {
      filters.push({
        field: "status",
        value: statusMatch[1].replace(" ", ""),
        operator: "isAnyOf",
      });
    }

    // Check for vehicle plate (e.g. "reisai lbk608", "reisas auto ABC123")
    const vehiclePlateMatch = text.match(/\b([A-Z]{2,3}\s?\d{2,4}[A-Z]*)\b/i);
    if (vehiclePlateMatch) {
      const countMatch = lower.match(/(\d+)\s*(?:newest|latest|recent|naujaus|paskutin)/);
      const pageSize = countMatch ? parseInt(countMatch[1], 10) : 5;
      return { type: "carriages_by_vehicle", filters: [], pageSize, vehiclePlate: vehiclePlateMatch[1].toUpperCase().replace(/\s/g, "") };
    }

    // Check for explicit count request
    const countMatch = lower.match(/(\d+)\s*(?:newest|latest|recent|naujaus|paskutin)/);
    const pageSize = countMatch ? parseInt(countMatch[1], 10) : 5;

    return { type: "find_carriages", filters, pageSize };
  }

  // Find drivers
  if (/driver|vairuotoj|vairuotojas/i.test(lower)) {
    const nameMatch = lower.match(
      /(?:driver|vairuotoj\w*)\s+(.+?)(?:\s*$|\s+(?:status|page))/i
    );
    return {
      type: "find_drivers",
      filters: [],
      quickFilter: nameMatch ? [nameMatch[1].trim()] : undefined,
      pageSize: 10,
    };
  }

  // Find vehicles
  if (/vehicle|truck|auto|mašin|sunkvežim|vilkik/i.test(lower)) {
    const plateMatch = lower.match(/([A-Z]{2,3}\s?\d{2,4})/i);
    const filters: ParsedCommand["filters"] = [];
    if (plateMatch) {
      filters.push({
        field: "driver",
        value: plateMatch[1],
        operator: "contains",
      });
    }
    return { type: "find_vehicles", filters, pageSize: 10 };
  }

  return { type: "unknown", filters: [], pageSize: 0 };
}

// ─── Format helpers ──────────────────────────────────────────────────

function formatCarriage(c: Record<string, unknown>): string {
  const route = c.route as Array<Record<string, unknown>> | undefined;
  let text = `🚛 *#${c.prettyId}* | ${c.status} | ${c.date ?? "?"}`;
  if (c.endDate) text += ` → ${c.endDate}`;
  text += "\n";

  const vehicle = c.vehicle as Record<string, unknown> | undefined;
  text += `Vehicle: ${vehicle?.number ?? "—"} | Driver: ${c.driverName ?? "—"}`;
  const customer = c.customer as Record<string, unknown> | undefined;
  if (customer?.name) text += ` | Customer: ${customer.name}`;
  text += ` | Price: ${c.price ?? "—"} EUR`;
  if (c.sellPrice) text += ` / Sell: ${c.sellPrice} EUR`;
  text += "\n";

  if (route && route.length > 0) {
    text += "Tasks:\n";
    route.forEach((t, i) => {
      const typeName = TASK_TYPES[t.type as number] ?? `Type ${t.type}`;
      const name = (t.name as string) || (t.city as string) || "Unknown";
      const place = (t.placeName as string) || "";
      const addr = (t.address as string) || "";
      text += `  ${i + 1}. ${name} (${typeName})`;
      if (place) text += ` — ${place}`;
      if (addr && addr !== place) text += `, ${addr}`;
      text += "\n";
    });
  }

  return text;
}

function formatDriver(d: Record<string, unknown>): string {
  return `👤 *${d.firstName} ${d.lastName}* | ${d.email ?? "—"} | ${d.phone ?? "—"} | Working: ${d.isWorking ? "Yes" : "No"}`;
}

function formatVehicle(v: Record<string, unknown>): string {
  const statusMap: Record<number, string> = {
    0: "Active",
    1: "Disassembled",
    2: "Sold",
    3: "ReRegistered",
    4: "Temp",
    5: "Unexploited",
    9: "Deleted",
  };
  const status = statusMap[v.status as number] ?? String(v.status);
  const drivers = v.drivers as string[] | undefined;
  return `🚚 *${v.number}* ${v.brand ?? ""} ${v.model ?? ""} | ${status} | Odometer: ${v.odometer ?? "—"} km | Drivers: ${drivers?.join(", ") ?? "—"}`;
}

// ─── Execute command ─────────────────────────────────────────────────

async function executeCommand(cmd: ParsedCommand): Promise<string> {
  const client = getBrunas();

  switch (cmd.type) {
    case "find_carriages": {
      const data = (await client.findCarriages(
        cmd.filters,
        0,
        cmd.pageSize,
        [{ field: "date", sort: "desc" }],
        cmd.quickFilter
      )) as { data: Record<string, unknown>[] };
      const carriages = data.data ?? [];
      if (carriages.length === 0) return "No carriages found.";
      return carriages.map(formatCarriage).join("\n");
    }

    case "carriages_by_vehicle": {
      // Step 1: find vehicle by plate number
      const vData = (await client.findVehicles(
        [{ field: "number", value: cmd.vehiclePlate!, operator: "contains" }],
        0, 5
      )) as { data: Record<string, unknown>[] };
      const vehicles = vData.data ?? [];
      if (vehicles.length === 0) return `Vehicle ${cmd.vehiclePlate} not found.`;
      const vehicleIds = vehicles.map((v) => v.id as number);
      // Step 2: find carriages for those vehicle IDs
      const cData = (await client.findCarriages(
        [{ field: "vehicle", value: vehicleIds, operator: "isAnyOf" }],
        0,
        cmd.pageSize,
        [{ field: "prettyId", sort: "desc" }]
      )) as { data: Record<string, unknown>[] };
      const carriages = cData.data ?? [];
      if (carriages.length === 0) return `No carriages found for vehicle ${cmd.vehiclePlate}.`;
      return `Carriages for ${cmd.vehiclePlate}:\n\n` + carriages.map(formatCarriage).join("\n");
    }

    case "find_drivers": {
      const data = (await client.findDrivers(
        cmd.filters,
        0,
        cmd.pageSize,
        undefined,
        cmd.quickFilter
      )) as { data: Record<string, unknown>[] };
      const drivers = data.data ?? [];
      if (drivers.length === 0) return "No drivers found.";
      return drivers.map(formatDriver).join("\n");
    }

    case "find_vehicles": {
      const data = (await client.findVehicles(
        cmd.filters,
        0,
        cmd.pageSize,
        undefined,
        cmd.quickFilter
      )) as { data: Record<string, unknown>[] };
      const vehicles = data.data ?? [];
      if (vehicles.length === 0) return "No vehicles found.";
      return vehicles.map(formatVehicle).join("\n");
    }

    default:
      return "";
  }
}

// ─── LID → phone resolver ────────────────────────────────────────────

const lidPhoneCache = new Map<string, string>();

function resolveLidToPhone(lid: string): string | null {
  if (lidPhoneCache.has(lid)) return lidPhoneCache.get(lid)!;
  try {
    if (!SQL) return null;
    const buf = fs.readFileSync(WHATSAPP_DB_PATH);
    const waDb = new SQL.Database(buf);
    const stmt = waDb.prepare("SELECT pn FROM whatsmeow_lid_map WHERE lid = ?");
    stmt.bind([lid]);
    let phone: string | null = null;
    if (stmt.step()) {
      phone = stmt.get()[0] as string;
      lidPhoneCache.set(lid, phone);
    }
    stmt.free();
    waDb.close();
    return phone;
  } catch {
    return null;
  }
}

function resolveRecipient(jid: string): string {
  // If it's a LID-based JID, resolve to phone-based JID for sending
  if (jid.endsWith("@lid")) {
    const lid = jid.replace("@lid", "");
    const phone = resolveLidToPhone(lid);
    if (phone) return `${phone}@s.whatsapp.net`;
  }
  return jid;
}

// ─── WhatsApp helpers ────────────────────────────────────────────────

async function sendWhatsApp(recipient: string, message: string): Promise<void> {
  const resolved = resolveRecipient(recipient);
  try {
    await axios.post(`${WHATSAPP_API}/api/send`, { recipient: resolved, message });
  } catch (err) {
    console.error(
      `Failed to send WhatsApp message to ${resolved}:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ─── Database polling ────────────────────────────────────────────────

let lastTimestamp: string | null = null;
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function openDb(): Promise<SqlJsDatabase> {
  if (!SQL) SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  return new SQL.Database(buf);
}

interface MessageRow {
  id: string;
  sender: string;
  content: string;
  chat_jid: string;
  timestamp: string;
}

function getNewMessages(
  db: SqlJsDatabase
): Array<{ id: string; sender: string; content: string; chatJid: string; timestamp: string }> {
  let stmt;
  if (lastTimestamp) {
    stmt = db.prepare(
      `SELECT id, sender, content, chat_jid, timestamp
       FROM messages
       WHERE is_from_me = 0 AND content != '' AND timestamp > ?
       ORDER BY timestamp ASC`
    );
    stmt.bind([lastTimestamp]);
  } else {
    stmt = db.prepare(
      `SELECT id, sender, content, chat_jid, timestamp
       FROM messages
       WHERE is_from_me = 0 AND content != ''
       ORDER BY timestamp DESC
       LIMIT 1`
    );
  }

  const rows: MessageRow[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as MessageRow;
    rows.push(row);
  }
  stmt.free();

  return rows.map((r) => ({
    id: r.id,
    sender: r.sender,
    content: r.content,
    chatJid: r.chat_jid,
    timestamp: r.timestamp,
  }));
}

// Track processed message IDs to avoid double-processing
const processedMessages = new Set<string>();
const MAX_PROCESSED_CACHE = 1000;

// ─── Main loop ───────────────────────────────────────────────────────

async function poll(): Promise<void> {
  let db: SqlJsDatabase | null = null;
  try {
    db = await openDb();
    const messages = getNewMessages(db);
    db.close();
    db = null;

    for (const msg of messages) {
      // Skip already processed
      if (processedMessages.has(msg.id)) continue;
      processedMessages.add(msg.id);

      // Evict old cache entries
      if (processedMessages.size > MAX_PROCESSED_CACHE) {
        const first = processedMessages.values().next().value;
        if (first) processedMessages.delete(first);
      }

      // Update watermark
      if (!lastTimestamp || msg.timestamp > lastTimestamp) {
        lastTimestamp = msg.timestamp;
      }

      // Check authorization
      const user = isAuthorized(msg.sender);
      if (!user) continue; // silently ignore unauthorized users

      console.log(
        `[${new Date().toISOString()}] ${user.name}: ${msg.content.substring(0, 80)}`
      );

      // Parse command
      const cmd = parseCommand(msg.content);
      if (cmd.type === "unknown") {
        await sendWhatsApp(
          msg.chatJid,
          `Sveiki, ${user.name}! Nesupratau užklausos.\n\n` +
            `Galimos komandos:\n` +
            `• *Reisas <nr>* — gauti reiso informaciją\n` +
            `• *Reisai* — paskutinių reisų sąrašas\n` +
            `• *Reisai <valst. nr>* — reisai pagal vilkiką\n` +
            `• *Vairuotojai* — vairuotojų sąrašas\n` +
            `• *Auto* — transporto priemonių sąrašas\n\n` +
            `Pavyzdžiai: "Reisas 5268", "Reisai LBK608", "Vairuotojai"`
        );
        console.log(`  → Unknown command, sent help`);
        continue;
      }

      // Execute and reply
      try {
        const result = await executeCommand(cmd);
        if (result) {
          await sendWhatsApp(msg.chatJid, result);
          console.log(`  → Replied (${result.length} chars)`);
        }
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);
        console.error(`  → Error: ${errMsg}`);
        await sendWhatsApp(
          msg.chatJid,
          `❌ Klaida apdorojant užklausą: ${errMsg}`
        );
      }
    }
  } catch (err) {
    if (db) db.close();
    console.error(
      "Poll error:",
      err instanceof Error ? err.message : err
    );
  }
}

async function main(): Promise<void> {
  // Validate config
  if (!process.env.BRUNAS_EMAIL || !process.env.BRUNAS_PASSWORD || !process.env.BRUNAS_CLIENT_URL) {
    console.error("Missing BRUNAS_EMAIL, BRUNAS_PASSWORD, or BRUNAS_CLIENT_URL");
    process.exit(1);
  }
  if (ALLOWED_USERS.length === 0) {
    console.error("No ALLOWED_WHATSAPP_USERS configured");
    process.exit(1);
  }

  console.log(`WhatsApp→TMS poller starting`);
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  API: ${WHATSAPP_API}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(
    `  Authorized users: ${ALLOWED_USERS.map((u) => u.name).join(", ")}`
  );

  // Set initial watermark to now (only process NEW messages)
  const db = await openDb();
  const stmt = db.prepare(
    "SELECT timestamp FROM messages WHERE is_from_me = 0 ORDER BY timestamp DESC LIMIT 1"
  );
  if (stmt.step()) {
    const row = stmt.getAsObject() as unknown as { timestamp: string };
    lastTimestamp = row.timestamp;
    console.log(`  Starting from: ${lastTimestamp}`);
  }
  stmt.free();
  db.close();

  console.log("  Listening for commands...\n");

  // Poll loop
  const interval = setInterval(() => poll(), POLL_INTERVAL_MS);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    clearInterval(interval);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

main();
