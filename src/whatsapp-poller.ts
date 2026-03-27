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
import OpenAI from "openai";

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

// ─── LLM (OpenAI-compatible) ─────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? undefined;

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (!OPENAI_API_KEY) return null;
  if (!openai) openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: OPENAI_BASE_URL });
  return openai;
}

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
  // Direct match on LID
  const direct = ALLOWED_USERS.find((u) => u.phone === clean);
  if (direct) return direct;
  // Reverse lookup: sender might be a phone number — resolve LID→phone and match
  for (const u of ALLOWED_USERS) {
    const phone = resolveLidToPhone(u.phone);
    if (phone && phone === clean) return u;
  }
  return null;
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

const CADENCY_STATUS_LABELS: Record<string, string> = {
  planning: "Planning",
  current: "Current",
  ended: "Ended",
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Command parsing & execution ─────────────────────────────────────

interface ParsedCommand {
  type:
    | "find_carriages"
    | "carriages_by_vehicle"
    | "find_drivers"
    | "find_vehicles"
    | "search_vehicles"
    | "register_damage"
    | "cadency_search"
    | "unknown";
  filters: Array<{ field: string; value: string | string[] | number[]; operator: string }>;
  quickFilter?: string[];
  pageSize: number;
  vehiclePlate?: string;
  searchQuery?: string;
  damageVehicle?: string;
  damageDescription?: string;
  _userPhone?: string;
  _chatJid?: string;
  driverName?: string;
  targetDate?: string;
  statusFilter?: string[];
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

  // Who is driving <vehicle>
  const whoDrivingMatch = text.match(
    /(?:who\s+(?:is\s+)?driving|kas\s+(?:dabar\s+)?vairuoja)\s+(?:truck|auto|vilkik\w*|vehicle)?\s*([A-Z0-9]{3,})/i
  );
  if (whoDrivingMatch) {
    const plate = whoDrivingMatch[1].replace(/[^A-Z0-9]/g, "").toUpperCase();
    if (plate.length >= 3) {
      return {
        type: "cadency_search",
        filters: [],
        pageSize: 5,
        vehiclePlate: plate,
        statusFilter: ["current"],
        targetDate: todayIsoDate(),
      };
    }
  }

  // What truck is <driver> driving?
  const driverTruckEn = text.match(
    /(?:what|which)\s+(?:truck|vehicle|auto)\s+(?:is\s+)?(.+?)\s+(?:driving|drives)/i
  );
  const driverTruckLt = text.match(/kok(?:i|į)\s+(?:vilkik\w*|auto)\s+vairuoja\s+(.+)/i);
  const driverNameRaw = driverTruckEn?.[1] ?? driverTruckLt?.[1];
  if (driverNameRaw) {
    const driverName = driverNameRaw.replace(/[^A-Za-zĀ-ž\s'-]/gi, " ").trim();
    if (driverName) {
      return {
        type: "cadency_search",
        filters: [],
        pageSize: 5,
        driverName,
        statusFilter: ["current"],
        targetDate: todayIsoDate(),
      };
    }
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

function parseDateValue(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function formatDateDisplay(date: Date | null): string {
  if (!date) return "—";
  return date.toISOString().slice(0, 10);
}

function getCadencyDriverName(row: Record<string, unknown>, fallback?: string): string {
  const driver = row.driver as Record<string, unknown> | undefined;
  if (driver) {
    const name = `${driver.firstName ?? ""} ${driver.lastName ?? ""}`.trim();
    if (name) return name;
  }
  if (typeof row.driver === "string") return row.driver;
  if (typeof row.driverName === "string") return row.driverName;
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
  return "Nežinomas vairuotojas";
}

function getCadencyVehicleNumber(row: Record<string, unknown>): string {
  const vehicle = row.vehicle as Record<string, unknown> | undefined;
  if (vehicle?.number) return String(vehicle.number);
  if (typeof row.vehicleNumber === "string") return row.vehicleNumber;
  return "Nežinomas vilkikas";
}

function formatCadencyRow(row: Record<string, unknown>): string {
  const driverName = getCadencyDriverName(row);
  const vehicleNumber = getCadencyVehicleNumber(row);
  const statusRaw = typeof row.status === "string" ? row.status : "";
  const statusLabel = CADENCY_STATUS_LABELS[statusRaw] ?? statusRaw ?? "";
  const from = formatDateDisplay(parseDateValue(row.dateFrom));
  const to = formatDateDisplay(parseDateValue(row.dateTo));
  return `👤 ${driverName} | 🚚 ${vehicleNumber} | ${statusLabel || "Unknown"}\n${from} → ${to}`;
}

function cadencyCoversDate(row: Record<string, unknown>, target: Date): boolean {
  const from = parseDateValue(row.dateFrom);
  if (!from) return false;
  const start = from.getTime();
  const check = target.getTime();
  if (check < start) return false;
  const to = parseDateValue(row.dateTo);
  if (!to) return true;
  return check <= to.getTime();
}

function buildCadencyAnswer(
  row: Record<string, unknown>,
  target: Date,
  context: { vehiclePlate?: string; driverName?: string }
): string {
  const driverName = getCadencyDriverName(row, context.driverName);
  const vehicleNumber = getCadencyVehicleNumber(row);
  const from = formatDateDisplay(parseDateValue(row.dateFrom));
  const toDate = parseDateValue(row.dateTo);
  const to = formatDateDisplay(toDate);
  const active = cadencyCoversDate(row, target);
  const rangeText = toDate ? `${from} → ${to}` : `${from} → dabar`;

  if (context.vehiclePlate) {
    if (active) {
      return `Šiuo metu vilkiką ${vehicleNumber} vairuoja ${driverName} (${rangeText}).`;
    }
    return `Vilkiką ${vehicleNumber} vairavo ${driverName} (${rangeText}).`;
  }

  if (context.driverName) {
    if (active) {
      return `${driverName} šiuo metu vairuoja vilkiką ${vehicleNumber} (${rangeText}).`;
    }
    return `${driverName} paskutinė kadencija: vilkikas ${vehicleNumber} (${rangeText}).`;
  }

  return formatCadencyRow(row);
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

    case "cadency_search": {
      const filters = [...cmd.filters];
      let quickFilter = cmd.quickFilter;

      if (cmd.vehiclePlate) {
        const normalized = cmd.vehiclePlate.replace(/\s+/g, "").toUpperCase();
        const vData = (await client.searchActiveVehicles(normalized)) as {
          data?: Array<{ id: number; number: string }>;
        };
        const vehicles = vData.data ?? [];
        const match = vehicles.find(
          (v) => v.number.replace(/\s+/g, "").toUpperCase() === normalized
        ) ?? vehicles[0];
        if (!match) {
          return `Vilkikas ${cmd.vehiclePlate} nerastas.`;
        }
        filters.push({ field: "vehicle", operator: "isAnyOf", value: [match.id] });
      }

      if (cmd.driverName) {
        if (!quickFilter || quickFilter.length === 0) {
          quickFilter = [cmd.driverName];
        }
      }

      if (cmd.statusFilter && cmd.statusFilter.length) {
        filters.push({ field: "status", operator: "isAnyOf", value: cmd.statusFilter });
      }

      const data = (await client.findCadencies(
        filters,
        0,
        cmd.pageSize ?? 5,
        [{ field: "dateFrom", sort: "desc" }],
        quickFilter
      )) as { data?: Record<string, unknown>[] };
      const cadencies = data.data ?? [];
      const targetDate = parseDateValue(cmd.targetDate ?? todayIsoDate()) ?? new Date();

      if ((cmd.vehiclePlate || cmd.driverName) && cadencies.length === 0) {
        if (cmd.vehiclePlate) {
          return `Nerasta kadencijų vilkikui ${cmd.vehiclePlate}.`;
        }
        return `Nerasta kadencijų vairuotojui ${cmd.driverName}.`;
      }

      if (cmd.vehiclePlate || cmd.driverName) {
        const active = cadencies.find((row) => cadencyCoversDate(row, targetDate));
        const candidate = active ?? cadencies[0];
        if (!candidate) {
          return `Kadencijų nerasta.`;
        }
        return buildCadencyAnswer(candidate, targetDate, {
          vehiclePlate: cmd.vehiclePlate,
          driverName: cmd.driverName,
        });
      }

      if (cadencies.length === 0) return "No cadencies found.";
      const limit = cmd.pageSize ?? 5;
      return cadencies
        .slice(0, limit)
        .map(formatCadencyRow)
        .join("\n\n");
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
        addRecentDamage(cmd._userPhone, {
          damageId,
          vehicleId,
          vehicleNumber,
          description: desc,
          urgency,
          category: "body-work",
          photosAttached: 0,
          registeredAt: Date.now(),
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
    console.log(`    [upload] Downloading message ${pm.id} from bridge...`);
    const localPath = await downloadFromBridge(pm.id, pm.chatJid);
    console.log(`    [upload] Downloaded to: ${localPath}`);

    // Step 2: upload to Brunas
    console.log(`    [upload] Uploading to Brunas...`);
    try {
      const uploadResult = (await client.uploadImage(localPath)) as {
        data?: { fullPath?: string };
      };
      console.log(`    [upload] Upload result: ${JSON.stringify(uploadResult)}`);
      const fullPath = uploadResult?.data?.fullPath;
      if (fullPath) {
        photoUrls.push(`https://upload.brunas.lt/read/${fullPath}`);
      }
    } catch (uploadErr: unknown) {
      const ax = uploadErr as { response?: { status?: number; data?: unknown } };
      console.error(`    [upload] Upload failed: status=${ax.response?.status}, body=${JSON.stringify(ax.response?.data)}`);
      throw uploadErr;
    }
  }

  // Step 3: update damage record with photo URLs
  if (photoUrls.length > 0) {
    console.log(`    [upload] Updating damage ${damageId} with ${photoUrls.length} photos...`);
    const updatePayload = {
      ...damageData,
      trailerId: null,
      status: "pending",
      photos: photoUrls,
    };
    console.log(`    [upload] Update payload: ${JSON.stringify(updatePayload)}`);
    try {
      await client.updateVehicleDamage(damageId, updatePayload);
      console.log(`    [upload] Damage updated successfully`);
    } catch (updateErr: unknown) {
      const ax = updateErr as { response?: { status?: number; data?: unknown } };
      console.error(`    [upload] Damage update failed: status=${ax.response?.status}, body=${JSON.stringify(ax.response?.data)}`);
      throw updateErr;
    }
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

interface PendingDamageDescription {
  type: "damage_await_description";
  vehiclePlate: string;
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

type PendingAction = PendingDamage | PendingDamageDescription | PendingDamagePhotos | PendingDamageConfirm;

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

// ─── Per-user conversation history (for LLM context) ─────────────────

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface RecentDamage {
  damageId: string;
  vehicleId: number;
  vehicleNumber: string;
  description: string;
  urgency: string;
  category: string;
  photosAttached: number;
  registeredAt: number;
}

const userHistory = new Map<string, ChatMessage[]>();
const userRecentDamages = new Map<string, RecentDamage[]>();
const HISTORY_MAX = 20;
const RECENT_DAMAGE_TTL_MS = 60 * 60 * 1000; // 1 hour

function addToHistory(userPhone: string, role: "user" | "assistant", content: string): void {
  if (!userHistory.has(userPhone)) userHistory.set(userPhone, []);
  const hist = userHistory.get(userPhone)!;
  hist.push({ role, content, timestamp: Date.now() });
  if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
}

function getHistory(userPhone: string): ChatMessage[] {
  return userHistory.get(userPhone) ?? [];
}

function addRecentDamage(userPhone: string, damage: RecentDamage): void {
  if (!userRecentDamages.has(userPhone)) userRecentDamages.set(userPhone, []);
  const list = userRecentDamages.get(userPhone)!;
  list.push(damage);
  const now = Date.now();
  while (list.length > 0 && now - list[0].registeredAt > RECENT_DAMAGE_TTL_MS) {
    list.shift();
  }
}

function getRecentDamages(userPhone: string): RecentDamage[] {
  const list = userRecentDamages.get(userPhone) ?? [];
  const now = Date.now();
  return list.filter((d) => now - d.registeredAt < RECENT_DAMAGE_TTL_MS);
}

function updateDamagePhotoCount(userPhone: string, damageId: string, count: number): void {
  const list = userRecentDamages.get(userPhone);
  if (!list) return;
  const d = list.find((x) => x.damageId === damageId);
  if (d) d.photosAttached += count;
}

// ─── LLM-powered smart routing ──────────────────────────────────────

interface LLMStepCommand {
  tool:
    | "find_carriages"
    | "carriages_by_vehicle"
    | "find_drivers"
    | "find_vehicles"
    | "search_vehicles"
    | "register_damage"
    | "cadency_search";
  pageSize?: number;
  vehiclePlate?: string;
  searchQuery?: string;
  filters?: Array<{ field: string; value: string | string[] | number[]; operator: string }>;
  quickFilter?: string[];
  damageVehicle?: string;
  damageDescription?: string;
  urgency?: string;
  driverName?: string;
  status?: string;
  statuses?: string[];
  date?: string;
  targetDate?: string;
  useVehicleFromPrevious?: boolean;
}

interface LLMDecision {
  action:
    | "attach_photos"
    | "register_damage"
    | "reply"
    | "command"
    | "multi_step"
    | "find_carriages"
    | "carriages_by_vehicle"
    | "find_drivers"
    | "find_vehicles"
    | "search_vehicles"
    | "cadency_search";
  damageId?: string;
  vehicleNumber?: string;
  description?: string;
  urgency?: string;
  text?: string;
  rawCommand?: string;
  steps?: LLMStepCommand[];
}

const LLM_SYSTEM_PROMPT = `Tu esi transporto įmonės asistentas WhatsApp žinutėse. Kalbi lietuviškai.
Tavo darbas — suprasti vartotojo žinutę ir nuspręsti, kokį veiksmą atlikti.

Galimi veiksmai (atsakyk JSON formatu):

1. {"action": "attach_photos", "damageId": "<id>", "vehicleNumber": "<nr>"}
   — Kai vartotojas siunčia nuotrauką/vaizdo įrašą ir yra neseniai registruotas gedimas

2. {"action": "register_damage", "vehicleNumber": "<nr>", "description": "<aprašymas>", "urgency": "tolerable|urgent"}
   — Kai vartotojas nori registruoti naują gedimą nurodydamas vilkiką

3. {"action": "command", "rawCommand": "<komanda>"}
   — Paprastos komandos: "reisas 5268", "vilkikas NBO401", "reisai LBK608", "vairuotojai"
   — rawCommand turi būti viena aiški komanda, kurią regex parseris gali suprasti

4. {"action": "multi_step", "steps": [...]}
   — Kelių žingsnių užduotys, kai vieno veiksmo nepakanka.
   — Kiekvienas žingsnis turi "tool" ir parametrus.
   — Jei žingsnis priklauso nuo prieš tai buvusio rezultato, pridėk "useVehicleFromPrevious": true

   Galimi tool tipai:
   - "find_carriages": ieškoti reisų. Parametrai: pageSize (kiek), filters (filtrai)
   - "carriages_by_vehicle": reisai pagal vilkiką. Parametrai: vehiclePlate, pageSize
   - "find_drivers": ieškoti vairuotojų. Parametrai: pageSize, quickFilter
   - "find_vehicles": ieškoti vilkikų. Parametrai: pageSize, quickFilter
   - "search_vehicles": ieškoti vilkiko. Parametrai: searchQuery
  - "cadency_search": rasti kadencijas (vairuotojo-priskyrimo laikotarpius). Parametrai: vehiclePlate, driverName, status, date
   - "register_damage": registruoti gedimą. Parametrai: damageVehicle, damageDescription, urgency

   Pvz: "surask paskutinį reisą ir užregistruok gedimą" →
   {"action": "multi_step", "steps": [
     {"tool": "find_carriages", "pageSize": 1},
     {"tool": "register_damage", "useVehicleFromPrevious": true, "damageDescription": ""}
   ]}

   Pvz: "koks vilkikas veža reisą 5268?" →
   {"action": "command", "rawCommand": "reisas 5268"}

5. {"action": "reply", "text": "<atsakymas>"}
   — Kai reikia paklausti patikslinimo arba atsakyti į bendrą klausimą
   — Naudok kai trūksta info (pvz gedimo aprašymo), arba bendram pokalbiui

TAISYKLĖS:
- "paskutinį reisą" / "naujausią reisą" = pageSize: 1
- "paskutinius 3 reisus" = pageSize: 3
- Jei vartotojas prašo kelių veiksmų vienu sakiniu (pvz "surask X ir padaryk Y") — VISADA naudok "multi_step"
- Jei register_damage žingsnyje nėra konkretaus vilkiko numerio, bet prieš tai buvo find_carriages — naudok "useVehicleFromPrevious": true
- Jei gedimo aprašymas nenurodtas, palik damageDescription tuščią — sistema paklaus vartotojo
- Jei vartotojas siunčia nuotrauką/video ir per paskutinę valandą buvo registruotas gedimas — paklausk ar pridėti (action: "reply")
- Jei yra keli neseniai registruoti gedimai — paklausk, prie kurio pridėti
- Niekada nesugalvok damageId — naudok tik iš pateikto konteksto
- Atsakyk TIKTAI JSON formatu, be jokio papildomo teksto`;

async function askLLM(
  userPhone: string,
  userName: string,
  messageContent: string,
  mediaType: string,
): Promise<LLMDecision | null> {
  const ai = getOpenAI();
  if (!ai) return null;

  const history = getHistory(userPhone);
  const recentDamages = getRecentDamages(userPhone);

  let contextBlock = "";
  if (recentDamages.length > 0) {
    contextBlock += "\nNeseniai registruoti gedimai šiam vartotojui:\n";
    for (const d of recentDamages) {
      const ago = Math.round((Date.now() - d.registeredAt) / 60000);
      contextBlock += `- ID: ${d.damageId}, Vilkikas: ${d.vehicleNumber}, Aprašymas: "${d.description}", Skubumas: ${d.urgency}, Nuotraukų: ${d.photosAttached}, Prieš ${ago} min.\n`;
    }
  }

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: LLM_SYSTEM_PROMPT + contextBlock },
  ];

  // Add recent conversation history (last 6 messages)
  const recent = history.slice(-6);
  for (const h of recent) {
    messages.push({ role: h.role, content: h.content });
  }

  // Add current message
  const currentContent = mediaType
    ? `[Vartotojas ${userName} atsiuntė ${mediaType === "video" ? "vaizdo įrašą" : "nuotrauką"}]${messageContent ? " " + messageContent : ""}`
    : messageContent;
  messages.push({ role: "user", content: currentContent });

  try {
    const response = await ai.chat.completions.create({
      model: LLM_MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 600,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    console.log(`    [LLM] Raw: ${raw}`);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as LLMDecision;
  } catch (err) {
    console.error(`    [LLM] Error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ─── Multi-step executor ─────────────────────────────────────────────

interface StepContext {
  lastVehiclePlate?: string;
  lastVehicleId?: number;
  lastCarriage?: Record<string, unknown>;
  results: string[];
}

async function executeMultiStep(
  steps: LLMStepCommand[],
  userPhone: string,
  chatJid: string,
): Promise<string> {
  const ctx: StepContext = { results: [] };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`    [multi-step] Step ${i + 1}/${steps.length}: ${step.tool}`);

    // Resolve vehicle from previous step if needed
    if (step.useVehicleFromPrevious && ctx.lastVehiclePlate) {
      if (step.tool === "register_damage") {
        step.damageVehicle = ctx.lastVehiclePlate;
      } else if (step.tool === "carriages_by_vehicle") {
        step.vehiclePlate = ctx.lastVehiclePlate;
      } else if (step.tool === "search_vehicles") {
        step.searchQuery = ctx.lastVehiclePlate;
      } else if (step.tool === "cadency_search") {
        step.vehiclePlate = ctx.lastVehiclePlate;
      }
    }

    // Pre-check: if register_damage has no description, ask user before calling API
    if (step.tool === "register_damage" && !step.damageDescription && ctx.lastVehiclePlate) {
      setPending(userPhone, {
        type: "damage_await_description" as const,
        vehiclePlate: step.damageVehicle ?? ctx.lastVehiclePlate,
        urgency: (step.urgency ?? "tolerable") as "urgent" | "tolerable",
        timestamp: Date.now(),
      });
      ctx.results.push(
        `🚛 Paskutinio reiso vilkikas: *${ctx.lastVehiclePlate}*\n` +
        `Įveskite gedimo aprašymą, kad užregistruotume gedimą šiam vilkikui.`
      );
      break;
    }

    // Build a ParsedCommand from the step
    const cmd: ParsedCommand = {
      type: step.tool,
      filters: step.filters ?? [],
      pageSize: step.pageSize ?? 5,
      quickFilter: step.quickFilter,
      vehiclePlate: step.vehiclePlate,
      searchQuery: step.searchQuery,
      damageVehicle: step.damageVehicle,
      damageDescription: step.damageDescription ?? "",
      _userPhone: userPhone,
      _chatJid: chatJid,
      driverName: step.driverName,
      statusFilter: step.status
        ? [step.status]
        : step.statuses,
      targetDate: step.date ?? step.targetDate,
    };

    try {
      const result = await executeCommand(cmd);

      // Extract vehicle info from carriage results for chaining
      if ((step.tool === "find_carriages" || step.tool === "carriages_by_vehicle") && result) {
        // Re-fetch to get structured data for context passing
        const client = getBrunas();
        const data = (await client.findCarriages(
          cmd.filters,
          0,
          cmd.pageSize,
          [{ field: "date", sort: "desc" }],
          cmd.quickFilter,
        )) as { data: Record<string, unknown>[] };
        const carriages = data.data ?? [];
        if (carriages.length > 0) {
          ctx.lastCarriage = carriages[0];
          const vehicle = carriages[0].vehicle as Record<string, unknown> | undefined;
          if (vehicle?.number) {
            ctx.lastVehiclePlate = vehicle.number as string;
            ctx.lastVehicleId = vehicle.id as number;
          }
        }
      }

      if (result) ctx.results.push(result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.results.push(`❌ Žingsnis ${i + 1} klaida: ${errMsg}`);
      console.error(`    [multi-step] Step ${i + 1} error: ${errMsg}`);
      break; // stop chain on error
    }
  }

  return ctx.results.join("\n\n");
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

      // ─── Handle image/video messages (photo flow) ────────────
      if (msg.mediaType === "image" || msg.mediaType === "video") {
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
        // No pending state — ask LLM if there's a recent damage to attach to
        console.log(`  → ${msg.mediaType} message, no pending — asking LLM...`);
        addToHistory(user.phone, "user", `[${msg.mediaType}]`);
        const decision = await askLLM(user.phone, user.name, msg.content, msg.mediaType);
        if (decision?.action === "attach_photos" && decision.damageId) {
          const recentDamage = getRecentDamages(user.phone).find((d) => d.damageId === decision.damageId);
          if (recentDamage) {
            setPending(user.phone, {
              type: "damage_confirm_photos",
              damageId: recentDamage.damageId,
              vehicleId: recentDamage.vehicleId,
              vehicleNumber: recentDamage.vehicleNumber,
              description: recentDamage.description,
              urgency: recentDamage.urgency as "urgent" | "tolerable",
              category: recentDamage.category,
              photoMessageIds: [{ id: msg.id, chatJid: msg.chatJid }],
              chatJid: msg.chatJid,
              timestamp: Date.now(),
            });
            const reply = `📷 Gauta 1 nuotrauka.\nPridėti prie gedimo (${recentDamage.vehicleNumber})?\nRašykite *Taip* arba *Ne*.`;
            await sendWhatsApp(msg.chatJid, reply);
            addToHistory(user.phone, "assistant", reply);
            console.log(`  → LLM: attach to ${recentDamage.vehicleNumber}, awaiting confirm`);
            continue;
          }
        }
        if (decision?.action === "reply" && decision.text) {
          await sendWhatsApp(msg.chatJid, decision.text);
          addToHistory(user.phone, "assistant", decision.text);
          console.log(`  → LLM replied (${decision.text.length} chars)`);
          continue;
        }
        console.log(`  → LLM: no action for ${msg.mediaType}`);
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
            updateDamagePhotoCount(user.phone, pendingCheck.damageId, urls.length);
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

      // ─── Handle pending damage clarification (user provides plate) ──
      const pendingDmg = getPending(user.phone);
      if (pendingDmg && pendingDmg.type === "damage_clarify_vehicle") {
        // Treat the raw message as plate or description clarification
        const plate = msg.content.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (plate.length >= 3) {
          clearPending(user.phone);
          const clarifyCmd: ParsedCommand = {
            type: "register_damage",
            filters: [],
            pageSize: 0,
            damageVehicle: plate,
            damageDescription: pendingDmg.description,
            _userPhone: user.phone,
            _chatJid: msg.chatJid,
          };
          try {
            const result = await executeCommand(clarifyCmd);
            if (result) {
              await sendWhatsApp(msg.chatJid, result);
              addToHistory(user.phone, "assistant", result);
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

      // ─── Handle pending damage description (vehicle known, need description) ──
      if (pendingDmg && pendingDmg.type === "damage_await_description") {
        const description = msg.content.trim();
        if (description.length >= 2) {
          clearPending(user.phone);
          const dmgCmd: ParsedCommand = {
            type: "register_damage",
            filters: [],
            pageSize: 0,
            damageVehicle: pendingDmg.vehiclePlate,
            damageDescription: description,
            _userPhone: user.phone,
            _chatJid: msg.chatJid,
          };
          try {
            const result = await executeCommand(dmgCmd);
            if (result) {
              await sendWhatsApp(msg.chatJid, result);
              addToHistory(user.phone, "assistant", result);
              console.log(`  → Damage registered with description (${result.length} chars)`);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`  → Error: ${errMsg}`);
            await sendWhatsApp(msg.chatJid, `❌ Klaida: ${errMsg}`);
          }
          continue;
        }
      }

      // ─── LLM-first routing ─────────────────────────────────────
      addToHistory(user.phone, "user", msg.content);
      console.log(`  → Asking LLM...`);
      const decision = await askLLM(user.phone, user.name, msg.content, "");

      if (decision) {
        console.log(`  → LLM action: ${decision.action}`);

        // ── multi_step ──
        if (decision.action === "multi_step" && decision.steps?.length) {
          try {
            clearPending(user.phone);
            const result = await executeMultiStep(decision.steps, user.phone, msg.chatJid);
            if (result) {
              await sendWhatsApp(msg.chatJid, result);
              addToHistory(user.phone, "assistant", result);
              console.log(`  → multi_step replied (${result.length} chars)`);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await sendWhatsApp(msg.chatJid, `❌ Klaida: ${errMsg}`);
          }
          continue;
        }

        // ── register_damage ──
        if (decision.action === "register_damage" && decision.vehicleNumber) {
          clearPending(user.phone);
          const dmgCmd: ParsedCommand = {
            type: "register_damage",
            filters: [],
            pageSize: 0,
            damageVehicle: decision.vehicleNumber.toUpperCase().replace(/[^A-Z0-9]/g, ""),
            damageDescription: decision.description ?? "",
            _userPhone: user.phone,
            _chatJid: msg.chatJid,
          };
          try {
            const result = await executeCommand(dmgCmd);
            if (result) {
              await sendWhatsApp(msg.chatJid, result);
              addToHistory(user.phone, "assistant", result);
              console.log(`  → LLM→register_damage (${result.length} chars)`);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await sendWhatsApp(msg.chatJid, `❌ Klaida: ${errMsg}`);
          }
          continue;
        }

        // ── command (simple) ──
        if (decision.action === "command" && decision.rawCommand) {
          const retryCmd = parseCommand(decision.rawCommand);
          if (retryCmd.type !== "unknown") {
            clearPending(user.phone);
            retryCmd._userPhone = user.phone;
            retryCmd._chatJid = msg.chatJid;
            try {
              const result = await executeCommand(retryCmd);
              if (result) {
                await sendWhatsApp(msg.chatJid, result);
                addToHistory(user.phone, "assistant", result);
                console.log(`  → LLM→command (${result.length} chars)`);
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await sendWhatsApp(msg.chatJid, `❌ Klaida: ${errMsg}`);
            }
            continue;
          }
        }

        // ── reply ──
        if (decision.action === "reply" && decision.text) {
          await sendWhatsApp(msg.chatJid, decision.text);
          addToHistory(user.phone, "assistant", decision.text);
          console.log(`  → LLM replied (${decision.text.length} chars)`);
          continue;
        }

        // ── LLM returned a tool name directly as action (e.g. "find_carriages") ──
        const toolActions = ["find_carriages", "carriages_by_vehicle", "find_drivers", "find_vehicles", "search_vehicles", "cadency_search"];
        if (toolActions.includes(decision.action)) {
          const raw = decision as unknown as Record<string, unknown>;
          try {
            clearPending(user.phone);
            const result = await executeMultiStep(
              [{
                tool: decision.action as LLMStepCommand["tool"],
                pageSize: raw.pageSize as number | undefined,
                vehiclePlate: raw.vehiclePlate as string | undefined,
                searchQuery: raw.searchQuery as string | undefined,
                quickFilter: raw.quickFilter as string[] | undefined,
                driverName: raw.driverName as string | undefined,
                status: raw.status as string | undefined,
                statuses: raw.statuses as string[] | undefined,
                date: raw.date as string | undefined,
                targetDate: raw.targetDate as string | undefined,
              }],
              user.phone,
              msg.chatJid,
            );
            if (result) {
              await sendWhatsApp(msg.chatJid, result);
              addToHistory(user.phone, "assistant", result);
              console.log(`  → LLM→direct tool (${result.length} chars)`);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await sendWhatsApp(msg.chatJid, `❌ Klaida: ${errMsg}`);
          }
          continue;
        }
      }

      // ─── Fallback: regex parser ────────────────────────────────
      console.log(`  → LLM no decision, trying regex...`);
      const cmd = parseCommand(msg.content);
      if (cmd.type !== "unknown") {
        clearPending(user.phone);
        cmd._userPhone = user.phone;
        cmd._chatJid = msg.chatJid;
        try {
          const result = await executeCommand(cmd);
          if (result) {
            await sendWhatsApp(msg.chatJid, result);
            addToHistory(user.phone, "assistant", result);
            console.log(`  → Regex replied (${result.length} chars)`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`  → Error: ${errMsg}`);
          await sendWhatsApp(msg.chatJid, `❌ Klaida: ${errMsg}`);
        }
        continue;
      }

      // ─── Final fallback: help message ──────────────────────────
      const helpMsg =
        `Sveiki, ${user.name}! Nesupratau užklausos.\n\n` +
        `Galimos komandos:\n` +
        `• *Reisas <nr>* — gauti reiso informaciją\n` +
        `• *Reisai* — paskutinių reisų sąrašas\n` +
        `• *Reisai <valst. nr>* — reisai pagal vilkiką\n` +
        `• *Vilkikas <valst. nr>* — vilkiko informacija\n` +
        `• *Vairuotojai* — vairuotojų sąrašas\n` +
        `• *Gedimas <valst. nr> <aprašymas>* — registruoti gedimą\n\n` +
        `Pavyzdžiai: "Reisas 5268", "Reisai LBK608", "Gedimas NBO401 sugedo veidrodis"`;
      await sendWhatsApp(msg.chatJid, helpMsg);
      addToHistory(user.phone, "assistant", helpMsg);
      console.log(`  → Sent help message`);
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
  console.log(`  LLM: ${OPENAI_API_KEY ? `${LLM_MODEL}${OPENAI_BASE_URL ? ` (${OPENAI_BASE_URL})` : ""}` : "disabled (no OPENAI_API_KEY)"}`);

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
