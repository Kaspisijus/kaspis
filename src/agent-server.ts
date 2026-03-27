#!/usr/bin/env node
/**
 * Brunas AI Agent Server
 *
 * Exposes:
 *  - Auth endpoints (Brunas login, session, client selection)
 *  - OpenAI-compatible /v1/chat/completions with tool-calling loop
 *  - /v1/models listing
 *
 * Designed to back Open WebUI (or any OpenAI-compatible client).
 */

import "dotenv/config";
import express from "express";
import crypto from "crypto";
import axios from "axios";
import https from "node:https";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { BrunasApiClient } from "./brunas-api.js";
import {
  loginWithCredentials,
  resolveClients,
  type ClientInfo,
} from "./shared/auth.js";
import {
  BRUNAS_TOOL_DEFS,
  BSS_TOOL_DEFS,
  ADMIN_TOOL_DEFS,
  toOpenAITools,
  type OpenAITool,
} from "./shared/tool-defs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.AGENT_PORT ?? "3002");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_TOOL_ITERATIONS = 15;
const DEFAULT_LLM_MODEL = (process.env.LLM_MODEL ?? "gpt-4o-mini").trim();
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? crypto.randomUUID();
const COOKIE_NAME = "agent_sid";

function parseAllowedModels(raw: string | undefined, defaultModel: string): string[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  if (!parsed.includes(defaultModel)) {
    parsed.unshift(defaultModel);
  }

  return Array.from(new Set(parsed));
}

const ALLOWED_LLM_MODELS = parseAllowedModels(process.env.LLM_MODELS, DEFAULT_LLM_MODEL);

// BSS ERP uses a self-signed certificate
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

// ─── Session Management ──────────────────────────────────────────────

interface UserSession {
  id: string;
  email: string;
  jwt: string;
  isSuper: boolean;
  clients: ClientInfo[];
  selectedClientId: string | null;
  brunasClient: BrunasApiClient | null;
  bssPassword: string | null;
  createdAt: number;
}

const sessions = new Map<string, UserSession>();
const emailIndex = new Map<string, string>(); // email → sessionId

function createSession(
  email: string,
  jwt: string,
  isSuper: boolean,
  clients: ClientInfo[],
): UserSession {
  // Remove previous session for this email
  const oldSid = emailIndex.get(email);
  if (oldSid) sessions.delete(oldSid);

  const id = crypto.randomUUID();
  const session: UserSession = {
    id,
    email,
    jwt,
    isSuper,
    clients,
    selectedClientId: clients.length === 1 ? clients[0].id : null,
    brunasClient: null,
    bssPassword: null,
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  emailIndex.set(email, id);
  return session;
}

function getSession(sessionId: string | undefined): UserSession | null {
  if (!sessionId) return null;
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    emailIndex.delete(s.email);
    return null;
  }
  return s;
}

function getSessionByEmail(email: string): UserSession | null {
  const sid = emailIndex.get(email);
  return sid ? getSession(sid) : null;
}

// Cleanup expired sessions every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(sid);
      emailIndex.delete(s.email);
    }
  }
}, 15 * 60 * 1000);

// ─── Cookie helpers ──────────────────────────────────────────────────

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (key) cookies[key] = val;
  }
  return cookies;
}

function setSessionCookie(
  res: express.Response,
  sessionId: string,
  openWebUIToken?: string | null,
): void {
  const cookies = [
    `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  ];
  if (openWebUIToken) {
    // NOT HttpOnly — Open WebUI frontend reads this via document.cookie
    cookies.push(`token=${openWebUIToken}; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  }
  res.setHeader("Set-Cookie", cookies);
}

function clearSessionCookie(res: express.Response): void {
  res.setHeader(
    "Set-Cookie",
    [
      `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      `token=; SameSite=Lax; Path=/; Max-Age=0`,
    ],
  );
}

// ─── Open WebUI JWT helper ───────────────────────────────────────────

const OPEN_WEBUI_INTERNAL = process.env.OPEN_WEBUI_INTERNAL_URL ?? "http://open-webui:8080";

/**
 * Obtain an Open WebUI JWT for the given email by calling the signin endpoint
 * with the trusted email header. Returns the token string or null on failure.
 */
async function getOpenWebUIToken(email: string): Promise<string | null> {
  try {
    const resp = await axios.post(
      `${OPEN_WEBUI_INTERNAL}/api/v1/auths/signin`,
      { email: "", password: "" },
      { headers: { "Content-Type": "application/json", "X-User-Email": email }, timeout: 5000 },
    );
    return resp.data?.token ?? null;
  } catch (err) {
    console.error("[getOpenWebUIToken] Failed for", email, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Get BrunasApiClient for session ─────────────────────────────────

function getSessionClient(session: UserSession): BrunasApiClient {
  if (!session.selectedClientId) {
    const listing = session.clients
      .map((c, i) => `${i + 1}. ${c.name} (${c.domain})`)
      .join("\n");
    throw new Error(
      `No client selected. Available clients:\n${listing}\nUse the select_client tool to choose one.`,
    );
  }
  if (!session.brunasClient) {
    const client = session.clients.find(
      (c) => c.id === session.selectedClientId,
    );
    if (!client) throw new Error("Selected client not found in client list");
    session.brunasClient = BrunasApiClient.fromToken(
      session.jwt,
      `https://${client.domain}`,
    );
    // On 401, mark session as expired (user must re-login via browser)
    session.brunasClient.setReAuthCallback(async () => {
      throw new Error("Session expired. Please log in again at /auth/login");
    });
  }
  return session.brunasClient;
}

// ─── Utility helpers (from brunas-server.ts) ─────────────────────────

function unwrapApiData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.data && typeof obj.data === "object") {
      return obj.data as Record<string, unknown>;
    }
    return obj;
  }
  return {};
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format`);
  }
  return value;
}

function normalizeCadencyDateTime(
  value: unknown,
  fieldName: string,
  required: boolean,
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${fieldName} is required`);
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      if (required) throw new Error(`${fieldName} is required`);
      return null;
    }
    if (ISO_DATE_RE.test(trimmed)) return `${trimmed}T00:00:00Z`;
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime()))
      throw new Error(`${fieldName} must be YYYY-MM-DD or ISO 8601`);
    return trimmed;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    if (isNaN(d.getTime()))
      throw new Error(`${fieldName} must be a valid timestamp`);
    return d.toISOString();
  }
  throw new Error(`${fieldName} must be a string or number`);
}

function normalizeMiddlemanInput(
  value: unknown,
  fieldName: string,
): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return { id: value };
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    if (t.startsWith("{")) return JSON.parse(t) as Record<string, unknown>;
    const n = Number(t);
    if (!Number.isNaN(n)) return { id: n };
    throw new Error(`${fieldName} must be an object or numeric ID`);
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  throw new Error(`${fieldName} must be an object or numeric ID`);
}

// ─── BSS SOAP helpers ────────────────────────────────────────────────

const BSS_USER = "API_DELTRA";
const BSS_ENV = "Deltra UAB";
const BSS_URL =
  "https://erp.bss.biz/ERPIntegrationServiceHost/BSSIT/v2/service/ErpEInvoiceIntegrationService";

function buildInvoiceXml(invoiceNumber: string, password: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<GetInvoiceStatus xmlns="http://erp.bss.biz/">
<request>
<User>${BSS_USER}</User>
<Password>${password}</Password>
<EnvironmentName>${BSS_ENV}</EnvironmentName>
<InvoiceNumber>${invoiceNumber}</InvoiceNumber>
</request>
</GetInvoiceStatus>
</soap:Body>
</soap:Envelope>`;
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

async function fetchInvoiceStatus(
  invoiceNumber: string,
  password: string,
): Promise<string> {
  const body = buildInvoiceXml(invoiceNumber, password);
  const resp = await axios.post(BSS_URL, body, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction:
        "http://erp.bss.biz/IErpEInvoiceIntegrationService/GetInvoiceStatus",
    },
    timeout: 30_000,
    validateStatus: () => true,
    httpsAgent,
  });
  const xml: string = resp.data;
  if (resp.status >= 400) {
    const fault = extractTag(xml, "faultstring") ?? xml.slice(0, 300);
    return `ERROR: HTTP ${resp.status}: ${fault}`;
  }
  const success = extractTag(xml, "Success");
  if (success?.toLowerCase() !== "true") {
    return `ERROR: ${extractTag(xml, "Message") ?? "BSS returned Success=false"}`;
  }
  return [
    `Invoice ${invoiceNumber}:`,
    `  Payment: ${extractTag(xml, "InvoicePaymentStatus")}`,
    `  Status: ${extractTag(xml, "InvoiceStatus")}`,
    `  Total: ${extractTag(xml, "InvoiceTotalPriceWithVAT")} EUR (VAT ${extractTag(xml, "InvoiceTotalVAT")})`,
    `  Unpaid: ${extractTag(xml, "InvoiceUnpaidBalance")} EUR`,
    `  Changed: ${extractTag(xml, "InvoiceStatusChangedDate")}`,
  ].join("\n");
}

// ─── Tool execution ──────────────────────────────────────────────────

async function executeTool(
  session: UserSession,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  // ── Admin tools ──
  if (toolName === "select_client") {
    const clientId = args.clientId as string;
    if (!clientId) throw new Error("clientId is required");
    const match = session.clients.find(
      (c) =>
        c.id === clientId ||
        c.name.toLowerCase() === clientId.toLowerCase() ||
        c.domain.toLowerCase() === clientId.toLowerCase(),
    );
    if (!match) {
      const listing = session.clients
        .map((c, i) => `${i + 1}. ${c.name} (${c.domain})`)
        .join("\n");
      throw new Error(`Client "${clientId}" not found.\nAvailable:\n${listing}`);
    }
    session.selectedClientId = match.id;
    session.brunasClient = null; // force re-creation
    return `Selected client: ${match.name} (https://${match.domain})`;
  }

  // ── BSS tools ──
  if (toolName === "set_bss_password") {
    session.bssPassword = args.password as string;
    return "BSS password set for this session.";
  }
  if (toolName === "check_invoice_status") {
    if (!session.bssPassword) return "BSS password not set. Call set_bss_password first.";
    const nums = (args.invoice_numbers as string[]) ?? [];
    if (!nums.length) throw new Error("invoice_numbers is required");
    const invoices = nums.map((n) => n.replace(/^([A-Za-z]+)(\d)/, "$1-$2"));
    const results = await Promise.all(
      invoices.map((n) => fetchInvoiceStatus(n, session.bssPassword!)),
    );
    return results.join("\n\n");
  }

  // ── All remaining tools need BrunasApiClient ──
  const client = getSessionClient(session);

  switch (toolName) {
    case "find_carriages":
      return JSON.stringify(
        await client.findCarriages(
          (args.filters as any) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as any,
          args.quickFilter as any,
        ),
        null,
        2,
      );

    case "get_carriage": {
      if (!args.id) throw new Error("id is required");
      return JSON.stringify(await client.getCarriage(args.id as string), null, 2);
    }

    case "find_drivers": {
      const qf =
        (args.quickFilter as string[]) ??
        (typeof args.searchDriver === "string" && (args.searchDriver as string).trim()
          ? [(args.searchDriver as string).trim()]
          : undefined);
      return JSON.stringify(
        await client.findDrivers(
          (args.filters as any) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as any,
          qf,
        ),
        null,
        2,
      );
    }

    case "get_driver":
      if (!args.id) throw new Error("id is required");
      return JSON.stringify(await client.getDriver(args.id as string), null, 2);

    case "create_driver": {
      const payload = args.data as Record<string, unknown>;
      if (!payload?.firstName || !payload?.lastName)
        throw new Error("data.firstName and data.lastName are required");
      return JSON.stringify(await client.createDriver(payload), null, 2);
    }

    case "update_driver": {
      const id = String(args.id);
      if (!id) throw new Error("id is required");
      const updates = args.updates as Record<string, unknown>;
      if (!updates) throw new Error("updates is required");
      const existing = unwrapApiData(await client.getDriver(id));
      const payload = { ...existing, ...updates, id: existing.id ?? args.id };
      return JSON.stringify(await client.updateDriver(id, payload), null, 2);
    }

    case "find_vehicles":
      return JSON.stringify(
        await client.findVehicles(
          (args.filters as any) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as any,
          args.quickFilter as any,
        ),
        null,
        2,
      );

    case "get_vehicle":
      if (!args.id) throw new Error("id is required");
      return JSON.stringify(await client.getVehicle(args.id as string), null, 2);

    case "search_vehicles": {
      if (!args.query) throw new Error("query is required");
      const query = args.query as string;
      const activeData = await client.searchActiveVehicles(query) as { data?: unknown[] };
      if (activeData.data && activeData.data.length > 0) {
        return JSON.stringify(activeData, null, 2);
      }
      // Fallback: search all statuses via datatable
      const fallbackData = await client.findVehicles(
        [{ field: "number", operator: "isAnyOfContains", value: [query.replace(/\s+/g, "").toUpperCase()] }],
        0,
        25,
      );
      const fbObj = (typeof fallbackData === "object" && fallbackData !== null ? fallbackData : {}) as Record<string, unknown>;
      const fbArr = Array.isArray(fbObj.data) ? fbObj.data : [];
      const result = {
        ...fbObj,
        _source: fbArr.length > 0 ? "find_vehicles_fallback" : "no_results",
        _note: "Active search returned 0 results. Searched all statuses via find_vehicles.",
      };
      return JSON.stringify(result, null, 2);
    }

    case "get_vehicle_by_id":
      if (!args.id) throw new Error("id is required");
      return JSON.stringify(await client.getVehicleById(args.id as number), null, 2);

    case "search_vehicle_models":
      if (!args.query) throw new Error("query is required");
      return JSON.stringify(await client.searchVehicleModels(args.query as string), null, 2);

    case "create_vehicle": {
      const vn = (args.vehicleNumber as string)?.replace(/\s+/g, "");
      const vm = args.vehicleModel as string | null;
      const vt = args.type as number;
      if (!vn || vt === undefined) throw new Error("vehicleNumber and type required");
      const payload: Record<string, unknown> = {
        id: null, name: "", vehicleNumber: vn, model: null, type: vt,
        status: (args.status as number) ?? 0,
        makeDate: (args.makeDate as string) ?? null,
        registrationDate: (args.registrationDate as string) ?? null,
        vehicleVin: (args.vin as string) ?? null,
        superstructure: { model: null, type: null, firstFloorFingernail: 0, secondFloorFingernail: 0 },
        tags: [], owner: null, license: null, licenseNr: null, manager: null, managerId: null,
        phone: null, emissionType: 1, co2EmissionClass: 0, engineType: 0, fuelType: 0,
        fuelCardPin: null, tankCapacity: null, telemetrySource: null, locationFromApp: false,
        rivileDepartmentCode: "", rivileCostCenterCode: "",
        superStructureMakeDate: null, cabinType: 0,
        fuelRateSummer: null, fuelRateWinter: null, leasingDate: null, leasingRedeemedDate: null,
      };
      const createResult = await client.createVehicle(payload);
      const created = ((createResult as any).data ?? createResult) as Record<string, unknown>;
      const newId = created.id as number;
      if (vm && newId) {
        const ex = unwrapApiData(await client.getVehicle(String(newId)));
        return JSON.stringify(await client.updateVehicle(newId, { ...ex, id: newId, model: vm }), null, 2);
      }
      return JSON.stringify(createResult, null, 2);
    }

    case "update_vehicle": {
      const vid = args.id as number;
      if (!vid) throw new Error("id is required");
      const ex = unwrapApiData(await client.getVehicle(String(vid)));
      const p: Record<string, unknown> = { ...ex, id: vid };
      if (args.number !== undefined) p.number = (args.number as string).replace(/\s+/g, "");
      if (args.vehicleModel !== undefined) p.model = args.vehicleModel;
      if (args.type !== undefined) p.type = args.type;
      if (args.status !== undefined) p.status = args.status;
      if (args.vin !== undefined) p.vin = args.vin;
      if (args.makeDate !== undefined) p.makeDate = args.makeDate;
      return JSON.stringify(await client.updateVehicle(vid, p), null, 2);
    }

    case "cadency_search": {
      let filters = ((args.filters as any) ?? []) as Array<{ field: string; value: unknown; operator: string }>;
      let qf = args.quickFilter as string[] | undefined;

      if (typeof args.vehicleId === "number")
        filters = [...filters, { field: "vehicle", operator: "isAnyOf", value: [args.vehicleId] }];
      if (typeof args.vehicleNumber === "string" && args.vehicleNumber) {
        const vn = (args.vehicleNumber as string).replace(/\s+/g, "").toUpperCase();
        const sr = (await client.searchActiveVehicles(vn) as any).data ?? [];
        const m = sr.find((v: any) => v.number.replace(/\s+/g, "").toUpperCase() === vn) ?? sr[0];
        if (!m) return `Vehicle "${args.vehicleNumber}" not found.`;
        filters = [...filters, { field: "vehicle", operator: "isAnyOf", value: [m.id] }];
      }
      if (typeof args.driverId === "number")
        filters = [...filters, { field: "driver", operator: "isAnyOf", value: [args.driverId] }];
      if (typeof args.driverName === "string" && args.driverName && (!qf || !qf.length))
        qf = [args.driverName as string];

      const statuses: string[] = [];
      if (args.status) statuses.push(args.status as string);
      if (Array.isArray(args.statuses)) statuses.push(...(args.statuses as string[]));
      if (statuses.length) filters = [...filters, { field: "status", operator: "isAnyOf", value: statuses }];
      if (args.dateFrom) filters = [...filters, { field: "dateFrom", operator: "onOrAfter", value: assertIsoDate(args.dateFrom, "dateFrom") }];
      if (args.dateTo) filters = [...filters, { field: "dateTo", operator: "onOrBefore", value: assertIsoDate(args.dateTo, "dateTo") }];

      return JSON.stringify(
        await client.findCadencies(filters as any, (args.page as number) ?? 0, (args.pageSize as number) ?? 25, args.sort as any, qf),
        null, 2,
      );
    }

    case "create_cadency": {
      const d = args.data as Record<string, unknown>;
      if (!d) throw new Error("data is required");
      const driverId = Number(d.driverId);
      const vehicleId = Number(d.vehicleId);
      if (!Number.isFinite(driverId) || !Number.isFinite(vehicleId))
        throw new Error("driverId and vehicleId must be numbers");
      const payload: Record<string, unknown> = {
        ...d, id: d.id ?? null, driverId, vehicleId,
        dateFrom: normalizeCadencyDateTime(d.dateFrom, "dateFrom", true),
        dateTo: normalizeCadencyDateTime(d.dateTo, "dateTo", false),
        dateLeaving: normalizeCadencyDateTime(d.dateLeaving, "dateLeaving", false),
        dateReturn: normalizeCadencyDateTime(d.dateReturn, "dateReturn", false),
        middleman: normalizeMiddlemanInput(d.middleman ?? d.middlemanId, "middleman"),
        middlemanFrom: normalizeMiddlemanInput(d.middlemanFrom ?? d.middlemanFromId, "middlemanFrom"),
      };
      delete payload.middlemanId;
      delete payload.middlemanFromId;
      return JSON.stringify(await client.createCadency(payload), null, 2);
    }

    case "update_cadency": {
      const cid = args.id as number;
      if (!Number.isFinite(cid)) throw new Error("id must be a number");
      const updates = args.updates as Record<string, unknown>;
      if (!updates) throw new Error("updates is required");
      const ex = unwrapApiData(await client.getCadency(cid));
      const p: Record<string, unknown> = { ...ex, ...updates, id: ex.id ?? cid };
      if (updates.driverId !== undefined) p.driverId = Number(updates.driverId);
      if (updates.vehicleId !== undefined) p.vehicleId = Number(updates.vehicleId);
      if (updates.dateFrom !== undefined) p.dateFrom = normalizeCadencyDateTime(updates.dateFrom, "dateFrom", true);
      if (updates.dateTo !== undefined) p.dateTo = normalizeCadencyDateTime(updates.dateTo, "dateTo", false);
      if (updates.dateLeaving !== undefined) p.dateLeaving = normalizeCadencyDateTime(updates.dateLeaving, "dateLeaving", false);
      if (updates.dateReturn !== undefined) p.dateReturn = normalizeCadencyDateTime(updates.dateReturn, "dateReturn", false);
      if ("middleman" in updates || "middlemanId" in updates)
        p.middleman = normalizeMiddlemanInput(updates.middleman ?? updates.middlemanId, "middleman");
      if ("middlemanFrom" in updates || "middlemanFromId" in updates)
        p.middlemanFrom = normalizeMiddlemanInput(updates.middlemanFrom ?? updates.middlemanFromId, "middlemanFrom");
      delete p.middlemanId;
      delete p.middlemanFromId;
      return JSON.stringify(await client.updateCadency(cid, p), null, 2);
    }

    case "find_trailers":
      return JSON.stringify(
        await client.findTrailers(
          (args.filters as any) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as any,
        ),
        null, 2,
      );

    case "get_trailer":
      if (!args.id) throw new Error("id is required");
      return JSON.stringify(await client.getTrailer(args.id as number), null, 2);

    case "create_trailer": {
      const rawModel = args.model;
      const rawType = args.type;
      const model = typeof rawModel === "string" ? JSON.parse(rawModel) : rawModel;
      const type = typeof rawType === "string" ? JSON.parse(rawType) : rawType;
      const payload = {
        id: null, trailerType: args.trailerType as number,
        model, type,
        number: (args.number as string).replace(/\s+/g, ""),
        documentNumber: (args.documentNumber as string) ?? null,
        vin: (args.vin as string) ?? null,
        firstFloorFingernail: (args.firstFloorFingernail as number) ?? 0,
        secondFloorFingernail: (args.secondFloorFingernail as number) ?? 0,
        fingernailCount: (args.fingernailCount as number) ?? 0,
        makeDate: (args.makeDate as string) ?? null,
        registrationDate: (args.registrationDate as string) ?? null,
        dyselis: (args.dyselis as boolean) ?? false,
        leasingDate: (args.leasingDate as string) ?? null,
        leasingRedeemedDate: (args.leasingRedeemedDate as string) ?? null,
      };
      return JSON.stringify(await client.createTrailer(payload), null, 2);
    }

    case "update_trailer": {
      const tid = args.id as number;
      if (!tid) throw new Error("id is required");
      const ex = unwrapApiData(await client.getTrailer(tid));
      const p: Record<string, unknown> = { ...ex, id: tid };
      const rm = args.model;
      const rt = args.type;
      if (rm) p.model = typeof rm === "string" ? JSON.parse(rm) : rm;
      if (rt) p.type = typeof rt === "string" ? JSON.parse(rt) : rt;
      if (args.trailerType !== undefined) p.trailerType = args.trailerType;
      if (args.number !== undefined) p.number = (args.number as string).replace(/\s+/g, "");
      if (args.vin !== undefined) p.vin = args.vin;
      if (args.makeDate !== undefined) p.makeDate = args.makeDate;
      if (args.dyselis !== undefined) p.dyselis = args.dyselis;
      return JSON.stringify(await client.updateTrailer(tid, p), null, 2);
    }

    case "hook_trailer_to_vehicle": {
      const vid = args.vehicleId as number;
      const tid = args.trailerId as number;
      if (!vid || !tid) throw new Error("vehicleId and trailerId required");
      const dateFrom = assertIsoDate(args.dateFrom, "dateFrom");
      const dateTo = args.dateTo ? assertIsoDate(args.dateTo, "dateTo") : null;
      const vehicle = unwrapApiData(await client.getVehicle(String(vid)));
      if (vehicle.expedition === undefined) vehicle.expedition = false;
      const trailer = unwrapApiData(await client.getTrailer(tid));
      const precheck = await client.getIntersectingVehicleTrailers(tid, {
        dateFrom, dateTo, skipVehicleId: vid, skipTrailerId: null,
      });
      const data = await client.createVehicleTrailer({ vehicle, trailer, dateFrom, dateTo });
      return JSON.stringify({ precheck, data }, null, 2);
    }

    case "edit_vehicle_trailer_link": {
      const vtid = args.vehicleTrailerId as number;
      if (!vtid) throw new Error("vehicleTrailerId required");
      const ex = unwrapApiData(await client.getVehicleTrailer(vtid));
      const p: Record<string, unknown> = { ...ex };
      if (args.vehicleId !== undefined) {
        const v = unwrapApiData(await client.getVehicle(String(args.vehicleId)));
        if (v.expedition === undefined) v.expedition = false;
        p.vehicle = v;
      }
      if (args.trailerId !== undefined) {
        p.trailer = unwrapApiData(await client.getTrailer(args.trailerId as number));
      }
      if (args.dateFrom !== undefined) p.dateFrom = assertIsoDate(args.dateFrom, "dateFrom");
      if (args.dateTo !== undefined) p.dateTo = args.dateTo === null ? null : assertIsoDate(args.dateTo, "dateTo");
      const trl = p.trailer as Record<string, unknown> | undefined;
      const veh = p.vehicle as Record<string, unknown> | undefined;
      const precheck = await client.getIntersectingVehicleTrailers(
        Number(trl?.id), {
          dateFrom: p.dateFrom as string,
          dateTo: (p.dateTo as string | null) ?? null,
          skipVehicleId: Number(veh?.id),
          skipTrailerId: vtid,
        },
      );
      const data = await client.editVehicleTrailer(vtid, p);
      return JSON.stringify({ precheck, data }, null, 2);
    }

    case "finish_vehicle_trailer_link": {
      const vtid = args.vehicleTrailerId as number;
      if (!vtid) throw new Error("vehicleTrailerId required");
      const dateTo = assertIsoDate(args.dateTo, "dateTo");
      return JSON.stringify(await client.finishVehicleTrailer(vtid, { dateTo }), null, 2);
    }

    case "delete_vehicle_trailer_link": {
      const vtid = args.vehicleTrailerId as number;
      if (!vtid) throw new Error("vehicleTrailerId required");
      return JSON.stringify(await client.deleteVehicleTrailer(vtid), null, 2);
    }

    case "search_superstructure_makes":
      if (!args.query) throw new Error("query required");
      return JSON.stringify(await client.searchSuperStructureMakes(args.query as string), null, 2);

    case "create_superstructure_make":
      if (!args.make) throw new Error("make required");
      return JSON.stringify(await client.createSuperStructureMake(args.make as string), null, 2);

    case "search_superstructure_models":
      if (!args.query) throw new Error("query required");
      return JSON.stringify(await client.searchSuperStructureModels(args.query as string), null, 2);

    case "create_superstructure_model":
      if (!args.type) throw new Error("type required");
      return JSON.stringify(await client.createSuperStructureModel(args.type as string), null, 2);

    case "search_damages": {
      let filters = ((args.filters as any) ?? []) as Array<{ field: string; value: unknown; operator: string }>;
      if (typeof args.vehicleNumber === "string" && args.vehicleNumber) {
        const sr = (await client.searchActiveVehicles(args.vehicleNumber as string) as any).data ?? [];
        const m = sr.find((v: any) => v.number.toUpperCase() === (args.vehicleNumber as string).toUpperCase()) ?? sr[0];
        if (!m) return `Vehicle "${args.vehicleNumber}" not found.`;
        filters = [...filters, { field: "transport", operator: "isAnyOf", value: [`vehicle-${m.id}`] }];
      }
      return JSON.stringify(
        await client.searchDamages(filters as any, (args.page as number) ?? 0, (args.pageSize as number) ?? 100, args.sort as any),
        null, 2,
      );
    }

    case "register_damage": {
      const vid = args.vehicleId as number;
      const desc = args.description as string;
      if (!vid || !desc) throw new Error("vehicleId and description required");
      return JSON.stringify(
        await client.registerVehicleDamage({
          vehicleId: vid, description: desc,
          urgency: (args.urgency as string) ?? "tolerable",
          category: (args.category as string) ?? "body-work",
          trailerId: (args.trailerId as number) ?? null,
        }),
        null, 2,
      );
    }

    case "update_damage": {
      if (!args.damageId || !args.data) throw new Error("damageId and data required");
      return JSON.stringify(
        await client.updateVehicleDamage(args.damageId as string, args.data as Record<string, unknown>),
        null, 2,
      );
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ─── System prompts ──────────────────────────────────────────────────

function getSystemPrompt(session: UserSession): string {
  const selectedClient = session.clients.find(
    (c) => c.id === session.selectedClientId,
  );
  const clientLine = selectedClient
    ? `You are currently connected to: ${selectedClient.name} (${selectedClient.domain}).`
    : `No client selected yet. ${session.clients.length} clients available.`;

  const base = `You are Brunas AI — an intelligent assistant for transportation management.
${clientLine}

When displaying carriage data, always include route tasks.
Task types: 5=Loading, 0=Unloading, 1=Fuel, 2=CarWash, 3=Service.
Format carriages as:
  Carriage #<prettyId> | <status> | <date> → <endDate>
  Vehicle: <vehicle.number> | Driver: <driverName> | Customer: <customer.name> | Price: <price> EUR

Respond in the same language as the user. Default to Lithuanian if unclear.
Be concise and helpful. Use tool calls when the user asks about data.`;

  if (session.isSuper) {
    return `${base}

You are a SUPER ADMIN. You have access to:
- Brunas TMS tools for all companies (carriages, drivers, vehicles, trailers, cadencies, damages)
- BSS accounting (invoice status queries — ask for BSS password first)
- Client switching (select_client tool to switch companies)
Available companies: ${session.clients.map((c) => `${c.name} (${c.domain})`).join(", ")}`;
  }

  return `${base}

You have access to Brunas TMS tools for your company:
- View and search carriages, drivers, vehicles, trailers, cadencies
- Create and update records
- Report vehicle damages
- Manage truck-trailer assignments`;
}

// ─── OpenAI chat handler ─────────────────────────────────────────────

function getToolsForSession(session: UserSession): OpenAITool[] {
  const tools = toOpenAITools(BRUNAS_TOOL_DEFS);
  if (session.isSuper) {
    tools.push(...toOpenAITools(ADMIN_TOOL_DEFS));
    tools.push(...toOpenAITools(BSS_TOOL_DEFS));
  }
  return tools;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

async function handleChat(
  session: UserSession,
  messages: ChatMessage[],
  shouldStream: boolean,
  res: express.Response,
  model: string,
): Promise<void> {
  const tools = getToolsForSession(session);
  const systemPrompt = getSystemPrompt(session);

  const allMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await openai.chat.completions.create({
      model,
      messages: allMessages as any,
      tools: tools.length > 0 ? (tools as any) : undefined,
    });

    const choice = response.choices[0];
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Final text response
      if (shouldStream) {
        simulateStream(res, msg.content ?? "", response.id, response.model);
      } else {
        res.json(response);
      }
      return;
    }

    // Execute tool calls
    allMessages.push({
      role: "assistant",
      content: msg.content,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: (tc as any).function.name, arguments: (tc as any).function.arguments },
      })),
    });

    for (const tc of msg.tool_calls) {
      const fn = (tc as any).function;
      let result: string;
      try {
        const toolArgs = JSON.parse(fn.arguments);
        result = await executeTool(session, fn.name, toolArgs);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      allMessages.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
      });
    }
  }

  // Max iterations reached
  const fallback = "Maximum tool iterations reached. Please refine your request.";
  if (shouldStream) {
    simulateStream(res, fallback, "chatcmpl-limit", model);
  } else {
    res.json({
      id: "chatcmpl-limit",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: fallback }, finish_reason: "stop" }],
    });
  }
}

function simulateStream(
  res: express.Response,
  text: string,
  id: string,
  model: string,
): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Role chunk
  res.write(
    `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`,
  );

  // Content in ~20-char chunks for smooth streaming feel
  const chunks = text.match(/.{1,20}/gs) ?? [text || " "];
  for (const chunk of chunks) {
    res.write(
      `data: ${JSON.stringify({
        id, object: "chat.completion.chunk", model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      })}\n\n`,
    );
  }

  // Finish chunk
  res.write(
    `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─── Login HTML ──────────────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Brunas AI — Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center;
           min-height: 100vh; background: #f0f2f5; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px;
            box-shadow: 0 2px 12px rgba(0,0,0,.1); width: 400px; }
    .logo { display: block; margin: 0 auto 1rem; max-width: 200px; height: auto; }
    .sub { color: #666; font-size: .85rem; margin-bottom: 1.5rem; text-align: center; }
    label { display: block; font-size: .85rem; font-weight: 500; margin-bottom: .3rem; color: #333; }
    input { width: 100%; padding: .65rem .75rem; border: 1px solid #d0d5dd; border-radius: 8px;
            font-size: .95rem; margin-bottom: 1rem; outline: none; transition: border .15s; }
    input:focus { border-color: #4f46e5; }
    button { width: 100%; padding: .7rem; background: #4f46e5; color: #fff; font-size: 1rem;
             font-weight: 600; border: none; border-radius: 8px; cursor: pointer; transition: background .15s; }
    button:hover { background: #4338ca; }
    button:disabled { background: #a5b4fc; cursor: not-allowed; }
    .error { background: #fef2f2; color: #991b1b; padding: .6rem .8rem; border-radius: 8px;
             font-size: .85rem; margin-bottom: 1rem; display: none; }
    .client-list { list-style: none; padding: 0; }
    .client-list li { padding: .8rem 1rem; border: 1px solid #e5e7eb; border-radius: 8px;
                       margin-bottom: .5rem; cursor: pointer; transition: all .15s; }
    .client-list li:hover { border-color: #4f46e5; background: #f5f3ff; }
    .client-list li .name { font-weight: 600; color: #1a1a2e; }
    .client-list li .domain { font-size: .8rem; color: #666; }
    #step-login, #step-clients { display: none; }
    #step-login.active, #step-clients.active { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/auth/logo.png" alt="Brunas" class="logo">
    <p class="sub">Sign in to Brunas AI Assistant</p>
    <div class="error" id="err"></div>

    <div id="step-login" class="active">
      <form id="loginForm">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email" autofocus>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password">
        <button type="submit" id="btn">Sign in</button>
      </form>
    </div>

    <div id="step-clients">
      <p class="sub">Select a company to continue</p>
      <ul class="client-list" id="clientList"></ul>
    </div>
  </div>
  <script>
    const err = document.getElementById('err');
    const stepLogin = document.getElementById('step-login');
    const stepClients = document.getElementById('step-clients');
    const clientList = document.getElementById('clientList');
    const btn = document.getElementById('btn');

    function syncTokenToLocalStorage() {
      const m = document.cookie.match(/(?:^|; )token=([^;]*)/);
      if (m) localStorage.token = decodeURIComponent(m[1]);
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('email').value,
            password: document.getElementById('password').value,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          err.textContent = data.error || 'Login failed';
          err.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Sign in';
          return;
        }
        if (data.needClientSelect) {
          showClients(data.clients);
        } else {
          syncTokenToLocalStorage();
          window.location.href = '/';
        }
      } catch (ex) {
        err.textContent = 'Network error';
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });

    function showClients(clients) {
      stepLogin.classList.remove('active');
      stepClients.classList.add('active');
      clientList.innerHTML = '';
      clients.forEach(c => {
        const li = document.createElement('li');
        li.innerHTML = '<span class="name">' + esc(c.name) + '</span><br><span class="domain">' + esc(c.domain) + '</span>';
        li.onclick = () => selectClient(c.id);
        clientList.appendChild(li);
      });
    }

    async function selectClient(clientId) {
      err.style.display = 'none';
      try {
        const res = await fetch('/auth/select-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId }),
        });
        const data = await res.json();
        if (data.ok) {
          syncTokenToLocalStorage();
          window.location.href = '/';
        } else {
          err.textContent = data.error || 'Selection failed';
          err.style.display = 'block';
        }
      } catch (ex) {
        err.textContent = 'Network error';
        err.style.display = 'block';
      }
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  </script>
</body>
</html>`;

// ─── Express App ─────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS for *.brunas.lt and localhost
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    origin &&
    (/\.brunas\.lt$/.test(new URL(origin).hostname) ||
      origin.includes("localhost"))
  ) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ─── Auth Routes ─────────────────────────────────────────────────────

// Open WebUI redirects to /auth/ on logout — redirect to our login page
app.get("/auth/", (_req, res) => {
  res.redirect("/auth/login");
});

app.get("/auth/login", (_req, res) => {
  res.type("html").send(LOGIN_HTML);
});

app.get("/auth/logo.png", (_req, res) => {
  const logoPath = path.join(__dirname, "..", "src", "brunas_logo.png");
  if (fs.existsSync(logoPath)) {
    res.type("png").sendFile(logoPath);
  } else {
    res.status(404).end();
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.json({ ok: false, error: "Email and password are required." });
    return;
  }
  try {
    const jwt = await loginWithCredentials(email, password);
    const { isSuper, clients } = await resolveClients(jwt);

    if (clients.length === 0) {
      res.json({ ok: false, error: "No accessible companies for this account." });
      return;
    }

    const session = createSession(email, jwt, isSuper, clients);

    // Obtain an Open WebUI JWT so the frontend is pre-authenticated
    const webuiToken = await getOpenWebUIToken(email);
    setSessionCookie(res, session.id, webuiToken);

    if (clients.length === 1) {
      res.json({ ok: true });
    } else {
      res.json({
        ok: true,
        needClientSelect: true,
        clients: clients.map((c) => ({ id: c.id, name: c.name, domain: c.domain })),
      });
    }
  } catch (ex: unknown) {
    const axErr = ex as { response?: { status?: number; data?: { message?: string } } };
    const msg =
      axErr.response?.data?.message ??
      (axErr.response?.status === 401 ? "Invalid email or password." : String(ex));
    res.json({ ok: false, error: msg });
  }
});

app.post("/auth/select-client", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[COOKIE_NAME]);
  if (!session) {
    res.status(401).json({ ok: false, error: "Not logged in." });
    return;
  }
  const { clientId } = req.body ?? {};
  const match = session.clients.find(
    (c) =>
      c.id === clientId ||
      c.name.toLowerCase() === (clientId ?? "").toLowerCase() ||
      c.domain.toLowerCase() === (clientId ?? "").toLowerCase(),
  );
  if (!match) {
    res.json({ ok: false, error: "Client not found." });
    return;
  }
  session.selectedClientId = match.id;
  session.brunasClient = null;
  res.json({ ok: true });
});

app.get("/auth/me", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[COOKIE_NAME]);
  if (!session) {
    res.status(401).json({ error: "Not logged in." });
    return;
  }
  const selectedClient = session.clients.find(
    (c) => c.id === session.selectedClientId,
  );
  res.json({
    email: session.email,
    isSuper: session.isSuper,
    clients: session.clients.map((c) => ({ id: c.id, name: c.name, domain: c.domain })),
    selectedClient: selectedClient
      ? { id: selectedClient.id, name: selectedClient.name, domain: selectedClient.domain }
      : null,
  });
});

app.post("/auth/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[COOKIE_NAME]);
  if (session) {
    sessions.delete(session.id);
    emailIndex.delete(session.email);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

/**
 * Internal validation endpoint used by nginx auth_request.
 * Returns 200 + X-User-Email header if valid session, 401 otherwise.
 */
app.get("/auth/validate", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[COOKIE_NAME]);
  if (!session) {
    res.status(401).end();
    return;
  }
  res.setHeader("X-User-Email", session.email);
  res.setHeader("X-User-Super", session.isSuper ? "true" : "false");
  res.status(200).end();
});

// ─── OpenAI-Compatible Routes ────────────────────────────────────────

/**
 * Resolve session for OpenAI API requests.
 * Priority: session cookie > Authorization Bearer (API key + user field) > email header.
 */
function resolveApiSession(req: express.Request): UserSession | null {
  // 1. Session cookie (direct browser access)
  const cookies = parseCookies(req.headers.cookie);
  const cookieSession = getSession(cookies[COOKIE_NAME]);
  if (cookieSession) return cookieSession;

  // 2. API key auth (from Open WebUI) + user identification
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const key = auth.slice(7);
    if (key === AGENT_API_KEY) {
      // Trusted caller — look up by user field in body or forwarded headers
      const userEmail =
        (req.body as Record<string, unknown>)?.user as string ||
        (req.headers["x-openwebui-user-email"] as string);
      if (userEmail) {
        return getSessionByEmail(userEmail);
      }
    }
  }

  // 3. Trusted header (from nginx proxy)
  const headerEmail = req.headers["x-user-email"] as string;
  if (headerEmail) {
    return getSessionByEmail(headerEmail);
  }

  return null;
}

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: ALLOWED_LLM_MODELS.map((modelId) => ({
      id: modelId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "brunas",
      name: modelId,
    })),
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const session = resolveApiSession(req);
  if (!session) {
    res.status(401).json({
      error: { message: "Not authenticated. Please log in at /auth/login", type: "auth_error" },
    });
    return;
  }

  const { messages, stream } = req.body as {
    messages?: ChatMessage[];
    stream?: boolean;
    model?: string;
  };

  const requestedModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const selectedModel = requestedModel || DEFAULT_LLM_MODEL;

  if (!ALLOWED_LLM_MODELS.includes(selectedModel)) {
    res.status(400).json({
      error: {
        message: `Unsupported model \"${selectedModel}\". Allowed models: ${ALLOWED_LLM_MODELS.join(", ")}`,
        type: "invalid_request",
      },
    });
    return;
  }

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({
      error: { message: "messages array is required", type: "invalid_request" },
    });
    return;
  }

  try {
    console.log(`[chat] user=${session.email} model=${selectedModel} stream=${stream ?? false}`);
    await handleChat(session, messages, stream ?? false, res, selectedModel);
  } catch (err) {
    console.error("Chat error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: msg, type: "server_error" },
      });
    }
  }
});

// ─── Start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Brunas AI Agent server running on port ${PORT}`);
  console.log(`Login page: http://localhost:${PORT}/auth/login`);
  console.log(`API key for Open WebUI: ${AGENT_API_KEY}`);
});
