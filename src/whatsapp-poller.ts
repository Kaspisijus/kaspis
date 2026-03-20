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
  type: "find_carriages" | "carriages_by_vehicle" | "find_drivers" | "find_vehicles" | "search_vehicles" | "register_damage" | "unknown";
  filters: Array<{ field: string; value: string | string[] | number[]; operator: string }>;
  quickFilter?: string[];
  pageSize: number;
  vehiclePlate?: string;
  searchQuery?: string;
  damageVehicle?: string;
  damageDescription?: string;
  _userPhone?: string;
  _chatJid?: string;
}

function parseCommand(text: string): ParsedCommand {
  const lower = text.toLowerCase().trim();

  // Register damage (e.g. "gedimas NBO401 kažkas sugedo", "užregistruok gęsimą ABC007, SKUBUS, description")
  const damageMatch = lower.match(
    /(?:u.?registru\S+\s+g\S*[sš]im\S*|g[eę][dž]im\S*|damage|registruoti\s+g\S*im\S*|prid[eė]ti\s+g\S*im\S*|register\s+damage|add\s+damage)\s+([\w\d]+)[,;\s]\s*(.*)/i
  );
  if (damageMatch) {
    const rawVehicle = damageMatch[1].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const rawDesc = damageMatch[2].trim();
    return {
      type: "register_damage",
      filters: [],
      pageSize: 0,
      damageVehicle: rawVehicle,
      damageDescription: rawDesc,
    };
  }

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
    // Extract the query part after the vehicle keyword
    const queryMatch = lower.match(/(?:vehicle|truck|auto|mašin\w*|sunkvežim\w*|vilkik\w*)\s+(.+)/i);
    if (queryMatch) {
      const query = queryMatch[1].trim().toUpperCase().replace(/\s/g, "");
      return { type: "search_vehicles", filters: [], pageSize: 10, searchQuery: query };
    }
    return { type: "find_vehicles", filters: [], pageSize: 10 };
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

function formatVehicleDetailed(v: Record<string, unknown>): string {
  const owner = v.owner as Record<string, unknown> | null;
  const license = v.license as Record<string, unknown> | null;
  let text = `🚚 *${v.name ?? v.number}*\n`;
  if (v.vin) text += `VIN: ${v.vin}\n`;
  if (v.odometer) text += `Odometer: ${v.odometer} km\n`;
  if (owner?.name) text += `Owner: ${owner.name}\n`;
  if (license?.name && license.name !== owner?.name) text += `License: ${license.name}\n`;
  if (v.managerName) text += `Manager: ${v.managerName}\n`;
  if (v.telemetrySource) text += `Telemetry: ${v.telemetrySource}\n`;
  const tags = v.tags as Array<Record<string, unknown>> | undefined;
  if (tags?.length) text += `Tags: ${tags.map((t) => t.label).join(", ")}\n`;
  return text.trimEnd();
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
      // Step 1: search active vehicles by plate
      const vData = (await client.searchActiveVehicles(cmd.vehiclePlate!)) as {
        data: Record<string, unknown>[];
      };
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

    case "search_vehicles": {
      const sData = (await client.searchActiveVehicles(cmd.searchQuery!)) as {
        data: Record<string, unknown>[];
      };
      const vehicles = sData.data ?? [];
      if (vehicles.length === 0) return `Vehicle "${cmd.searchQuery}" not found.`;
      return vehicles.map(formatVehicleDetailed).join("\n\n");
    }

    case "register_damage": {
      // Step 1: find vehicle by plate/name
      const vData = (await client.searchActiveVehicles(cmd.damageVehicle!)) as {
        data: Record<string, unknown>[];
      };
      const vehicles = vData.data ?? [];
      if (vehicles.length === 0)
        return `Transporto priemonė "${cmd.damageVehicle}" nerasta. Negalima registruoti gedimo.`;

      if (vehicles.length > 1) {
        // Save pending state so user can reply with just the plate
        const rawDesc = cmd.damageDescription ?? "";
        const isUrgentEarly = /\b(urgent|skub\w*|critical|kritin\w*)\b/i.test(rawDesc);
        if (cmd._userPhone) {
          setPending(cmd._userPhone, {
            type: "damage_clarify_vehicle",
            description: rawDesc,
            urgency: isUrgentEarly ? "urgent" : "tolerable",
            timestamp: Date.now(),
          });
        }
        const list = vehicles
          .map((v, i) => `${i + 1}. ${v.number} — ${v.name ?? ""}`)
          .join("\n");
        return `Rasta kelios transporto priemonės pagal "${cmd.damageVehicle}":\n${list}\n\nParašykite tikslų valstybinį numerį.`;
      }

      const vehicle = vehicles[0];
      const vehicleId = vehicle.id as number;
      const vehicleNumber = vehicle.number as string;

      // Detect urgency from description and strip urgency keywords from final description
      const rawDesc = cmd.damageDescription ?? "";
      const isUrgent = /\b(urgent|skub\w*|critical|kritin\w*)\b/i.test(rawDesc);
      const urgency = isUrgent ? "urgent" : "tolerable";
      const desc = rawDesc
        .replace(/\b(urgent|skub\w*|critical|kritin\w*)[,;\s]*/gi, "")
        .trim();

      // Step 2: register damage
      const result = await client.registerVehicleDamage({
        vehicleId,
        description: desc,
        urgency,
      });
      const resData = result as { data?: { id?: string } };
      const damageId = resData?.data?.id ?? "";

      // Set pending state to await photos
      if (cmd._userPhone && damageId) {
        setPending(cmd._userPhone, {
          type: "damage_await_photos",
          damageId,
          vehicleId,
          vehicleNumber,
          description: desc,
          urgency: urgency as "urgent" | "tolerable",
          category: "body-work",
          photos: [],
          chatJid: cmd._chatJid ?? "",
          timestamp: Date.now(),
        });
      }

      return `\u2705 Gedimas užregistruotas!\nVilkikas: ${vehicleNumber}\nAprašymas: ${desc}\nSkubumas: ${urgency === "urgent" ? "Skubus" : "Toleruojamas"}\n\nGalite siųsti nuotraukas — jos bus pridėtos prie šio gedimo.`;
    }

    default:
      return "";
  }
}

// ─── Photo download (bridge) + upload (Brunas) ───────────────────────

async function downloadFromBridge(messageId: string, chatJid: string): Promise<string> {
  const resp = await axios.post(`${WHATSAPP_API}/api/download`, {
    message_id: messageId,
    chat_jid: chatJid,
  });
  const data = resp.data as { success: boolean; path?: string; message?: string };
  if (!data.success || !data.path) {
    throw new Error(`Bridge download failed: ${data.message ?? "unknown"}`);
  }
  return data.path; // absolute local path
}

async function uploadAndAttachPhotos(
  photoMessages: Array<{ id: string; chatJid: string }>,
  damageId: string,
  damageData: { vehicleId: number; description: string; urgency: string; category: string }
): Promise<string[]> {
  const client = getBrunas();
  const photoUrls: string[] = [];

  for (const pm of photoMessages) {
    // Step 1: download from WhatsApp via bridge
    const localPath = await downloadFromBridge(pm.id, pm.chatJid);

    // Step 2: upload to Brunas
    const uploadResult = (await client.uploadImage(localPath)) as {
      data?: { fullPath?: string };
    };
    const fullPath = uploadResult?.data?.fullPath;
    if (fullPath) {
      photoUrls.push(`https://upload.brunas.lt/read/${fullPath}`);
    }
  }

  // Step 3: update damage record with photo URLs
  if (photoUrls.length > 0) {
    await client.updateVehicleDamage(damageId, {
      ...damageData,
      trailerId: null,
      status: "pending",
      photos: photoUrls,
    });
  }

  return photoUrls;
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

let lastTimestampMs: number = 0;
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function openDb(): Promise<SqlJsDatabase> {
  if (!SQL) SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  return new SQL.Database(buf);
}

/** Parse any timestamp string into epoch ms */
function tsToMs(ts: string): number {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

interface MessageRow {
  id: string;
  sender: string;
  content: string;
  chat_jid: string;
  timestamp: string;
  media_type: string;
}

function getNewMessages(
  db: SqlJsDatabase
): Array<{ id: string; sender: string; content: string; chatJid: string; timestamp: string; mediaType: string }> {
  // Fetch all incoming messages (text or media), filter by epoch ms in JS
  const stmt = db.prepare(
    `SELECT id, sender, content, chat_jid, timestamp, media_type
     FROM messages
     WHERE is_from_me = 0 AND (content != '' OR media_type != '')
     ORDER BY timestamp ASC`
  );

  const rows: MessageRow[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as MessageRow;
    rows.push(row);
  }
  stmt.free();

  const mapRow = (r: MessageRow) => ({
    id: r.id,
    sender: r.sender,
    content: r.content ?? "",
    chatJid: r.chat_jid,
    timestamp: r.timestamp,
    mediaType: r.media_type ?? "",
  });

  // If we have a watermark, filter to only newer messages
  if (lastTimestampMs > 0) {
    return rows.filter((r) => tsToMs(r.timestamp) > lastTimestampMs).map(mapRow);
  }

  // First run: just return the last message to set watermark
  const last = rows.length > 0 ? [rows[rows.length - 1]] : [];
  return last.map(mapRow);
}

// ─── Pending actions (conversation state) ────────────────────────────

interface PendingDamage {
  type: "damage_clarify_vehicle";
  description: string;
  urgency: "urgent" | "tolerable";
  timestamp: number;
}

interface PendingDamagePhotos {
  type: "damage_await_photos";
  damageId: string;
  vehicleId: number;
  vehicleNumber: string;
  description: string;
  urgency: "urgent" | "tolerable";
  category: string;
  photos: string[]; // collected message IDs
  chatJid: string;
  timestamp: number;
}

interface PendingDamageConfirm {
  type: "damage_confirm_photos";
  damageId: string;
  vehicleId: number;
  vehicleNumber: string;
  description: string;
  urgency: "urgent" | "tolerable";
  category: string;
  photoMessageIds: Array<{ id: string; chatJid: string }>;
  chatJid: string;
  timestamp: number;
}

type PendingAction = PendingDamage | PendingDamagePhotos | PendingDamageConfirm;

// Keyed by user phone/LID (the clean identifier from AllowedUser)
const pendingActions = new Map<string, PendingAction>();
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min expiry

function setPending(userPhone: string, action: PendingAction): void {
  pendingActions.set(userPhone, action);
}

function getPending(userPhone: string): PendingAction | null {
  const action = pendingActions.get(userPhone);
  if (!action) return null;
  if (Date.now() - action.timestamp > PENDING_TTL_MS) {
    pendingActions.delete(userPhone);
    return null;
  }
  return action;
}

function clearPending(userPhone: string): void {
  pendingActions.delete(userPhone);
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
      const msgMs = tsToMs(msg.timestamp);
      if (msgMs > lastTimestampMs) {
        lastTimestampMs = msgMs;
      }

      // Check authorization
      const user = isAuthorized(msg.sender);
      if (!user) continue; // silently ignore unauthorized users

      console.log(
        `[${new Date().toISOString()}] ${user.name}: ${msg.mediaType ? `[${msg.mediaType}] ` : ""}${msg.content.substring(0, 80)}`
      );

      // ─── Handle image messages (photo flow) ───────────────────
      if (msg.mediaType === "image") {
        const pending = getPending(user.phone);
        if (pending && pending.type === "damage_await_photos") {
          // First photo after damage registration — collect and ask for more or confirm
          const photoList: Array<{ id: string; chatJid: string }> = [{ id: msg.id, chatJid: msg.chatJid }];
          setPending(user.phone, {
            type: "damage_confirm_photos",
            damageId: pending.damageId,
            vehicleId: pending.vehicleId,
            vehicleNumber: pending.vehicleNumber,
            description: pending.description,
            urgency: pending.urgency,
            category: pending.category,
            photoMessageIds: photoList,
            chatJid: msg.chatJid,
            timestamp: Date.now(),
          });
          await sendWhatsApp(
            msg.chatJid,
            `📷 Gauta 1 nuotrauka.\nSiųskite daugiau arba rašykite *Taip* — pridėti prie gedimo (${pending.vehicleNumber}).`
          );
          console.log(`  → Photo collected (1), awaiting confirm`);
          continue;
        }
        if (pending && pending.type === "damage_confirm_photos") {
          // Additional photo — add to collection
          pending.photoMessageIds.push({ id: msg.id, chatJid: msg.chatJid });
          pending.timestamp = Date.now(); // refresh TTL
          await sendWhatsApp(
            msg.chatJid,
            `📷 Gauta ${pending.photoMessageIds.length} nuotrauk${pending.photoMessageIds.length === 1 ? "a" : "os"}.\nSiųskite daugiau arba rašykite *Taip* — pridėti prie gedimo (${pending.vehicleNumber}).`
          );
          console.log(`  → Photo collected (${pending.photoMessageIds.length}), awaiting confirm`);
          continue;
        }
        // Image but no pending damage — ignore silently
        console.log(`  → Image message, no pending damage — skipped`);
        continue;
      }

      // ─── Handle confirmation for pending photos ────────────────
      const pendingCheck = getPending(user.phone);
      if (pendingCheck && pendingCheck.type === "damage_confirm_photos") {
        const lower = msg.content.toLowerCase().trim();
        if (/^(taip|yes|jo|t|y|ok|gerai|pridek|pridėk|prisek|prisekit)$/i.test(lower)) {
          // User confirmed — process upload
          clearPending(user.phone);
          try {
            await sendWhatsApp(msg.chatJid, `⏳ Įkeliamos ${pendingCheck.photoMessageIds.length} nuotrauk${pendingCheck.photoMessageIds.length === 1 ? "a" : "os"}...`);
            const urls = await uploadAndAttachPhotos(
              pendingCheck.photoMessageIds,
              pendingCheck.damageId,
              {
                vehicleId: pendingCheck.vehicleId,
                description: pendingCheck.description,
                urgency: pendingCheck.urgency,
                category: pendingCheck.category,
              }
            );
            await sendWhatsApp(
              msg.chatJid,
              `✅ ${urls.length} nuotrauk${urls.length === 1 ? "a pridėta" : "os pridėtos"} prie gedimo (${pendingCheck.vehicleNumber}).`
            );
            console.log(`  → ${urls.length} photos uploaded and attached to damage ${pendingCheck.damageId}`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`  → Photo upload error: ${errMsg}`);
            await sendWhatsApp(msg.chatJid, `❌ Klaida įkeliant nuotraukas: ${errMsg}`);
          }
          continue;
        }
        if (/^(ne|no|n|atšauk|atsaukti|cancel)$/i.test(lower)) {
          clearPending(user.phone);
          await sendWhatsApp(msg.chatJid, `Nuotraukos nebus pridėtos.`);
          console.log(`  → Photo attachment cancelled`);
          continue;
        }
        // Any other text while photos pending — clear pending and process normally
        clearPending(user.phone);
      }

      // Parse command
      const cmd = parseCommand(msg.content);

      // Check for pending action clarification
      if (cmd.type === "unknown") {
        const pending = getPending(user.phone);
        if (pending && pending.type === "damage_clarify_vehicle") {
          // Treat the raw message as the vehicle plate clarification
          const plate = msg.content.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (plate.length >= 3) {
            clearPending(user.phone);
            const clarifyCmd: ParsedCommand = {
              type: "register_damage",
              filters: [],
              pageSize: 0,
              damageVehicle: plate,
              damageDescription: pending.description,
              _userPhone: user.phone,
              _chatJid: msg.chatJid,
            };
            try {
              const result = await executeCommand(clarifyCmd);
              if (result) {
                await sendWhatsApp(msg.chatJid, result);
                console.log(`  → Clarification replied (${result.length} chars)`);
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(`  → Error: ${errMsg}`);
              await sendWhatsApp(msg.chatJid, `❌ Klaida: ${errMsg}`);
            }
            continue;
          }
        }
      }

      if (cmd.type === "unknown") {
        await sendWhatsApp(
          msg.chatJid,
          `Sveiki, ${user.name}! Nesupratau užklausos.\n\n` +
            `Galimos komandos:\n` +
            `• *Reisas <nr>* — gauti reiso informaciją\n` +
            `• *Reisai* — paskutinių reisų sąrašas\n` +
            `• *Reisai <valst. nr>* — reisai pagal vilkiką\n` +
            `• *Vilkikas <valst. nr>* — vilkiko informacija\n` +
            `• *Vairuotojai* — vairuotojų sąrašas\n` +
            `• *Gedimas <valst. nr> <aprašymas>* — registruoti gedimą\n\n` +
            `Pavyzdžiai: "Reisas 5268", "Reisai LBK608", "Gedimas NBO401 sugedo veidrodis"`
        );
        console.log(`  → Unknown command, sent help`);
        continue;
      }

      // Execute and reply
      try {
        clearPending(user.phone); // new command clears any pending clarification
        cmd._userPhone = user.phone;
        cmd._chatJid = msg.chatJid;
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
    lastTimestampMs = tsToMs(row.timestamp);
    console.log(`  Starting from: ${row.timestamp} (${lastTimestampMs})`);
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
