#!/usr/bin/env node

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import express from "express";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { BrunasApiClient } from "./brunas-api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple error classes (same pattern as index.ts)
class McpError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "McpError";
  }
}

const ErrorCode = {
  InvalidRequest: "InvalidRequest",
  MethodNotFound: "MethodNotFound",
  InternalError: "InternalError",
};

// ─── Auth state ──────────────────────────────────────────────────────

interface ClientInfo {
  id: string;
  name: string;
  domain: string;
}

interface ClientSelectionMessageOptions {
  title: string;
  instruction: string;
  isSuper?: boolean;
}

let storedJwt: string | null = null;
let resolvedClients: ClientInfo[] | null = null;
let selectedClientId: string | null = null;
let brunasClient: BrunasApiClient | null = null;

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Brunas TMS Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           display: flex; justify-content: center; align-items: center;
           min-height: 100vh; background: #f0f2f5; }
    .card { background: #fff; padding: 2.5rem; border-radius: 12px;
            box-shadow: 0 2px 12px rgba(0,0,0,.1); width: 380px; }
    h1 { font-size: 1.4rem; margin-bottom: .3rem; color: #1a1a2e; }
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
    .success { background: #f0fdf4; color: #166534; padding: .6rem .8rem; border-radius: 8px;
               font-size: .85rem; margin-bottom: 1rem; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/logo.png" alt="Brunas" class="logo">
    <p class="sub">Sign in to connect your account</p>
    <div class="error" id="err"></div>
    <div class="success" id="ok"></div>
    <form id="f">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <button type="submit" id="btn">Sign in</button>
    </form>
  </div>
  <script>
    const f = document.getElementById('f');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    const ok = document.getElementById('ok');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      ok.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Signing in\u2026';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('email').value,
            password: document.getElementById('password').value,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          ok.textContent = 'Logged in! You can close this window.';
          ok.style.display = 'block';
          f.style.display = 'none';
        } else {
          err.textContent = data.error || 'Login failed';
          err.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Sign in';
        }
      } catch (ex) {
        err.textContent = 'Network error: ' + ex.message;
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });
  </script>
</body>
</html>`;

/**
 * Start a local Express server with a login form, open it in Chromium,
 * and wait for the user to authenticate. The server POSTs credentials to
 * auth.brunas.lt server-side and captures the JWT.
 */
async function performBrowserLogin(): Promise<{ jwt: string }> {
  return new Promise<{ jwt: string }>((resolve, reject) => {
    const app = express();
    app.use(express.json());

    let settled = false;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    app.get("/logo.png", (_req, res) => {
      const logoPath = path.join(__dirname, "..", "src", "brunas_logo.png");
      if (fs.existsSync(logoPath)) {
        res.type("png").sendFile(logoPath);
      } else {
        res.status(404).end();
      }
    });

    app.get("/", (_req, res) => {
      res.type("html").send(LOGIN_HTML);
    });

    app.post("/api/login", async (req, res) => {
      const { email, password } = req.body ?? {};
      if (!email || !password) {
        res.json({ ok: false, error: "Email and password are required." });
        return;
      }
      try {
        const authRes = await axios.post("https://auth.brunas.lt/auth/login", {
          email,
          password,
          remember: false,
          login_type: "email_password",
        });
        const jwt = authRes.data?.data?.jwt;
        if (!jwt) {
          res.json({ ok: false, error: "Unexpected response — no JWT returned." });
          return;
        }
        res.json({ ok: true });
        if (!settled) {
          settled = true;
          // Give the response a moment to reach the browser, then clean up
          setTimeout(() => {
            httpServer.close();
            browser?.close().catch(() => {});
            resolve({ jwt });
          }, 500);
        }
      } catch (ex: unknown) {
        const axErr = ex as { response?: { status?: number; data?: { message?: string } } };
        const msg =
          axErr.response?.data?.message ??
          (axErr.response?.status === 401 ? "Invalid email or password." : String(ex));
        res.json({ ok: false, error: msg });
      }
    });

    const httpServer = app.listen(0, "127.0.0.1", async () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      console.error(`Brunas login page: ${url}`);

      try {
        browser = await chromium.launch({ headless: false });
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(url);
      } catch {
        // If Playwright fails, the user can still open the URL manually
        console.error(`Open ${url} in your browser to log in.`);
      }
    });

    // 3-minute timeout
    setTimeout(() => {
      if (!settled) {
        settled = true;
        httpServer.close();
        browser?.close().catch(() => {});
        reject(
          new McpError(
            ErrorCode.InternalError,
            "Login timed out — no credentials submitted within 3 minutes."
          )
        );
      }
    }, 180_000);
  });
}

/**
 * Query the Brunas auth API to determine which clients the user has
 * access to, then resolve them against the full client list.
 */
async function resolveClients(
  jwt: string
): Promise<{ isSuper: boolean; clients: ClientInfo[] }> {
  const authHttp = axios.create({
    baseURL: "https://savitarna.brunas.lt",
    headers: {
      "Content-Type": "application/json",
      Cookie: `jwt=${jwt}`,
    },
  });

  // 1. Get access info
  const accessRes = await authHttp.get("/auth/auth/access");
  const accessData = accessRes.data?.data ?? {};
  const isSuper: boolean = accessData.super === true;
  const accessList: Array<{ clientId: string }> = accessData.access ?? [];
  const allowedIds = new Set(accessList.map((a) => a.clientId));

  // 2. Get full client list
  const clientsRes = await authHttp.get("/auth/clients");
  const allClients: Array<{
    id: string;
    name: string;
    domains?: string[];
  }> = clientsRes.data?.data ?? [];

  // 3. Filter to accessible clients
  const filtered = isSuper
    ? allClients
    : allClients.filter((c) => allowedIds.has(c.id));

  const clients: ClientInfo[] = filtered.map((c) => ({
    id: c.id,
    name: c.name,
    domain: c.domains?.[0] ?? "",
  }));

  return { isSuper, clients };
}

function formatClientSelectionMessage(
  clients: ClientInfo[],
  options: ClientSelectionMessageOptions
): string {
  const listing = clients
    .map((c, i) => `${i + 1}. ${c.name} - ${c.domain}`)
    .join("\n");

  return [
    `${options.title}${options.isSuper ? " (super user)" : ""}`,
    `Accessible clients (${clients.length}):`,
    listing,
    "",
    options.instruction,
    `Accepted input: exact client name or exact domain.`,
  ].join("\n");
}

/**
 * Get (or create) the BrunasApiClient. Triggers browser login and
 * client resolution as needed.
 */
async function getClient(): Promise<BrunasApiClient> {
  if (brunasClient) return brunasClient;

  // Step 1: ensure we have a JWT
  if (!storedJwt) {
    const result = await performBrowserLogin();
    storedJwt = result.jwt;
    resolvedClients = null;
    selectedClientId = null;
  }

  // Step 2: resolve available clients
  if (!resolvedClients) {
    const { clients } = await resolveClients(storedJwt);
    resolvedClients = clients;

    if (clients.length === 0) {
      throw new McpError(
        ErrorCode.InternalError,
        "No accessible clients found for this account."
      );
    }

    if (clients.length === 1) {
      // Auto-select the only client
      selectedClientId = clients[0].id;
    }
  }

  // Step 3: ensure a client is selected
  if (!selectedClientId) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      formatClientSelectionMessage(resolvedClients, {
        title: "Multiple clients available and none is selected.",
        instruction: "Call brunas_select_client with the exact client name or domain to continue.",
      })
    );
  }

  // Step 4: build the API client
  const selected = resolvedClients.find((c) => c.id === selectedClientId)!;
  const clientUrl = `https://${selected.domain}`;

  brunasClient = BrunasApiClient.fromToken(storedJwt, clientUrl);
  brunasClient.setReAuthCallback(async () => {
    // On 401, re-trigger browser login
    const result = await performBrowserLogin();
    storedJwt = result.jwt;
    // Keep the same client selection — just refresh the token
    return result.jwt;
  });

  return brunasClient;
}

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
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${fieldName} must be in YYYY-MM-DD format`
    );
  }
  return value;
}

// ─── Filter-field documentation (embedded in tool descriptions) ──────

const CARRIAGE_FIELDS_DOC = `Available filter fields for carriages:
  - status (isAnyOf): draft, confirmed, inProgress, finished, invoiced, cancelled
  - date (range): loading date, e.g. "2025-01-01"
  - createDate (range): creation date
  - prettyId (contains): short carriage number like "1234"
  - orderNumber (contains): order reference
  - refNumber (contains): reference number
  - comment (contains): free text
  - managerName (contains): transport manager name
  - salesManagerName (contains): sales manager name
  - cmrType (isAnyOf): vins, liquids, weighed
  - invoiceStatus (isAnyOf): new, submitted, declined, cancelled, invoiced, paid
  - price (equals): cost value
  - sellPrice (equals): revenue value
  - vehicle (isAnyOf): array of vehicle IDs (numbers), e.g. [1183]`;

const VEHICLE_FIELDS_DOC = `Available filter fields for vehicles:
  - status (isAnyOf): 0=Active, 1=Disassembled, 2=Sold, 3=ReRegistered, 4=Temp, 5=Unexploited, 9=Deleted
  - type (isAnyOf): 0=VehicleCarrier, 1=Freezer, 2=Tent, 3=Car, 4=Container, 5=Other, 6=SimpleTruck, 7=Cistern
  - driver (contains): driver name
  - trailerNumber (contains): trailer plate number
  - tags (isAnyOf): tag values
  - manager (isAnyOf): transport manager
  - middleman (isAnyOf): license owner`;

const DRIVER_FIELDS_DOC = `Driver search (searchDriver behavior) is implemented through this tool.
Use quickFilter parameter for text search across driver name fields.`;

const CADENCY_FIELDS_DOC = `Available filter fields for cadencies (driver-vehicle timelines):
  - status (isAnyOf): planning, current, ended
  - vehicle (isAnyOf): array of vehicle IDs (numbers)
  - driver (isAnyOf): array of driver IDs (numbers)
  - dateFrom (onOrAfter/onOrBefore): loading/start date range
  - dateTo (onOrAfter/onOrBefore): end date range
  - company / fromCompany (contains): company name text search`;

const driverFormFieldProperties = {
  id: { type: "number" },
  firstName: { type: "string" },
  lastName: { type: "string" },
  personalCode: { type: "string" },
  birthday: { type: "string", description: "Date in YYYY-MM-DD format" },
  nationality: { type: "string" },
  language: { type: "string", description: "lt, en, de, fr, ru, pl" },
  picture: { type: "string" },
  agnumKey: { type: "string" },
  finvaldaKey: { type: "string" },
  email: { type: "string" },
  login: { type: "string" },
  password: { type: "string" },
  status: { type: "boolean" },
  tags: { type: "array", items: { type: "string" } },
  employmentDate: { type: "string", description: "Date in YYYY-MM-DD format" },
  dismissDate: { type: "string", description: "Date in YYYY-MM-DD format" },
  phone: { type: "string" },
  phonePersonal: { type: "string" },
  homeAddress: { type: "string" },
  declarationAddress: { type: "string" },
  socialSecurityNumber: { type: "string" },
  accountNumber: { type: "string" },
  childrenInfo: { type: "string" },
  finishedVehicle: { type: "boolean" },
  truck: { type: "boolean" },
  timeCardNumber: { type: "string" },
};

const cadencyFormFieldProperties = {
  id: { type: ["number", "null"], description: "Cadency ID (leave null on create)" },
  driverId: { type: "number", description: "Driver ID" },
  vehicleId: { type: "number", description: "Vehicle ID" },
  dateFrom: { type: "string", description: "Start date/time (YYYY-MM-DD or ISO 8601)" },
  dateTo: { type: ["string", "null"], description: "Optional end date/time" },
  dateLeaving: { type: ["string", "null"], description: "Optional leave date/time" },
  dateReturn: { type: ["string", "null"], description: "Optional return date/time" },
  middleman: { type: "object", description: "Full middleman object { id, name, ... }", additionalProperties: true },
  middlemanId: { type: "number", description: "Shortcut: numeric middleman ID" },
  middlemanFrom: { type: "object", description: "Middleman-from object", additionalProperties: true },
  middlemanFromId: { type: "number", description: "Shortcut: numeric middleman-from ID" },
};

function normalizeCadencyDateTime(
  value: unknown,
  fieldName: string,
  required: boolean
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${fieldName} is required`
      );
    }
    return null;
  }

  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${fieldName} must be a valid date`
      );
    }
    return value.toISOString();
  }

  if (typeof value === "number") {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${fieldName} must be a valid timestamp`
      );
    }
    return date.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      if (required) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${fieldName} is required`
        );
      }
      return null;
    }

    if (ISO_DATE_RE.test(trimmed)) {
      return `${trimmed}T00:00:00Z`;
    }

    // Validate the string parses, but preserve the original format
    // (keeps timezone offsets like +02:00 instead of converting to UTC)
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${fieldName} must be YYYY-MM-DD or ISO 8601 date-time`
      );
    }
    return trimmed;
  }

  throw new McpError(
    ErrorCode.InvalidRequest,
    `${fieldName} must be a string, number, or Date`
  );
}

function normalizeMiddlemanInput(
  value: unknown,
  fieldName: string
): Record<string, unknown> | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${fieldName} numeric ID must be finite`
      );
    }
    return { id: value };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${fieldName} JSON string could not be parsed`
        );
      }
    }
    const maybeId = Number(trimmed);
    if (!Number.isNaN(maybeId)) {
      return { id: maybeId };
    }
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${fieldName} must be an object or numeric ID`
    );
  }

  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }

  throw new McpError(
    ErrorCode.InvalidRequest,
    `${fieldName} must be an object or numeric ID`
  );
}

// ─── Shared JSON-Schema fragments ────────────────────────────────────

const filterItemSchema = {
  type: "object",
  properties: {
    field: { type: "string", description: "Field name to filter on" },
    value: {
      description: "Filter value (string, number, or array for isAnyOf)",
    },
    operator: {
      type: "string",
      description:
        "Operator: contains, equals, startsWith, endsWith, isAnyOf, range",
    },
  },
  required: ["field", "value", "operator"],
};

const sortItemSchema = {
  type: "object",
  properties: {
    field: { type: "string" },
    sort: { type: "string", enum: ["asc", "desc"] },
  },
  required: ["field", "sort"],
};

const datatableInputProperties = {
  filters: {
    type: "array",
    items: filterItemSchema,
    description: "Filter items (empty array = no filter)",
  },
  quickFilter: {
    type: "array",
    items: { type: "string" },
    description: "Quick text search values applied across searchable columns",
  },
  page: { type: "number", description: "Page number (0-based, default 0)" },
  pageSize: {
    type: "number",
    description: "Results per page (default 25)",
  },
  sort: {
    type: "array",
    items: sortItemSchema,
    description: "Sort order",
  },
};

// ─── Tool definitions ────────────────────────────────────────────────

const tools = [
  {
    name: "brunas_login",
    description:
      "Authenticate to Brunas TMS by opening a browser login window. Opens a Chromium browser to the Brunas login page — log in manually. After login, resolves accessible clients. If only one client is accessible, it is auto-selected. If multiple clients are available, always returns a numbered list with client names and domains and asks for a follow-up brunas_select_client call.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "brunas_logout",
    description:
      "Log out of Brunas TMS. Clears the current session and invalidates the JWT token.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "brunas_select_client",
    description:
      "Select which Brunas client (company) to work with. Use after brunas_login when multiple clients are available. Pass the exact client name or exact domain from the list returned by brunas_login.",
    inputSchema: {
      type: "object",
      properties: {
        clientId: {
          type: "string",
          description: "Exact client name or exact domain to select",
        },
      },
      required: ["clientId"],
    },
  },
  {
    name: "find_carriages",
    description: `Search carriages (transport trips) in Brunas TMS with filters and pagination.\n${CARRIAGE_FIELDS_DOC}`,
    inputSchema: {
      type: "object",
      properties: datatableInputProperties,
    },
  },
  {
    name: "find_drivers",
    description: `Search drivers in Brunas TMS.\n${DRIVER_FIELDS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        ...datatableInputProperties,
        searchDriver: {
          type: "string",
          description: "Optional single text query alias. Internally mapped to quickFilter=[searchDriver].",
        },
      },
    },
  },
  {
    name: "find_vehicles",
    description: `Search vehicles/trucks in Brunas TMS.\n${VEHICLE_FIELDS_DOC}`,
    inputSchema: {
      type: "object",
      properties: datatableInputProperties,
    },
  },
  {
    name: "get_carriage",
    description:
      "Get full details of a single carriage by its ID (UUID or numeric).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Carriage ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_driver",
    description: "Get full details of a single driver by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Driver ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_driver",
    description: "Create a new driver in Brunas TMS using the same full form payload shape as the UI (POST /api/v3/drivers/).",
    inputSchema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: driverFormFieldProperties,
          required: ["firstName", "lastName"],
          additionalProperties: true,
        },
      },
      required: ["data"],
    },
  },
  {
    name: "update_driver",
    description: "Update an existing driver by ID with full-object semantics. Fetches current driver form, merges provided updates, then sends full payload via PUT /api/v3/drivers/{id}.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Driver ID" },
        updates: {
          type: "object",
          properties: driverFormFieldProperties,
          additionalProperties: true,
        },
      },
      required: ["id", "updates"],
    },
  },
  {
    name: "cadency_search",
    description: `Search driver-vehicle cadencies (timeline assignments) in Brunas TMS.\n${CADENCY_FIELDS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        ...datatableInputProperties,
        vehicleId: { type: "number", description: "Vehicle ID shortcut (adds vehicle filter)" },
        vehicleNumber: { type: "string", description: "Vehicle plate number shortcut (resolves to ID via search_vehicles)" },
        driverId: { type: "number", description: "Driver ID shortcut" },
        driverName: { type: "string", description: "Driver name quick search (maps to quickFilter if provided)" },
        status: { type: "string", description: "Single status filter: planning, current, or ended" },
        statuses: { type: "array", items: { type: "string" }, description: "Multiple status values" },
        dateFrom: { type: "string", description: "Start date >= filter (YYYY-MM-DD)" },
        dateTo: { type: "string", description: "End date <= filter (YYYY-MM-DD)" },
      },
    },
  },
  {
    name: "create_cadency",
    description: "Create a new driver-vehicle cadency (timeline assignment) via POST /api/v3/vehicle-driver. Mirrors the Truckservice Timeline form (driverId, vehicleId, date range, middlemen).",
    inputSchema: {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: cadencyFormFieldProperties,
          required: ["driverId", "vehicleId", "dateFrom"],
          additionalProperties: true,
        },
      },
      required: ["data"],
    },
  },
  {
    name: "update_cadency",
    description: "Update an existing cadency by ID with fetch-merge semantics (GET form, merge updates, PUT /api/v3/vehicle-driver/{id}).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Cadency ID" },
        updates: {
          type: "object",
          properties: cadencyFormFieldProperties,
          additionalProperties: true,
        },
      },
      required: ["id", "updates"],
    },
  },
  {
    name: "get_vehicle",
    description: "Get full vehicle form data by ID (v3/form endpoint). Returns: id, name, type, model (string), vehicleVin, superstructure, manager, owner, license, tags, status, emissionType, tankCapacity, fuelRates, makeDate, leasingDate, etc. Used internally by update_vehicle for fetch-merge.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Vehicle ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_vehicles",
    description: "Search vehicles by plate number or name. Searches active first; if nothing found, automatically falls back to all statuses (disassembled, sold, etc.). Returns matching vehicles with id, number, name, vin, owner, manager, etc.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (partial plate number or name, e.g. 'nb', 'LBK608')" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_vehicle_models",
    description: "Search vehicle (truck) makes/models by name query. Vehicles have a single concatenated make+model record (e.g. 'Mercedes Benz Actros 1841'). Returns matching models with id and model name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (partial make/model name, e.g. 'merc', 'volvo')" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_vehicle_by_id",
    description: `Get a single vehicle/truck by ID from Brunas TMS.
Returns: id, name, number, model (string), vin, type, status, makeYear, managerId, managerName, euroClass, drivers, fuelConsumption, tankCapacity, owner, license, tags, leasingDate, leasingRedeemedDate, failuresCount, periodicTasksCount, etc.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Vehicle ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_vehicle",
    description: `Create a new vehicle/truck in Brunas TMS.
type values: 0=VehicleCarrier, 1=Freezer, 2=Tent, 3=Car, 4=Container, 5=Other, 6=SimpleTruck, 7=Cistern.
IMPORTANT: If type is not provided, do NOT guess — ask the user to choose from the list above before calling this tool.
model: plain string — the make/model name (e.g. "Mercedes Benz 1841"). Use search_vehicle_models to find valid names.`,
    inputSchema: {
      type: "object",
      properties: {
        vehicleNumber: { type: "string", description: "Vehicle plate number (e.g. 'ABC123')" },
        vehicleModel: { type: "string", description: "Model name string (e.g. 'Daf XF', 'Mercedes Benz Actros 1841')" },
        type: { type: "number", description: "Vehicle type: 0=VehicleCarrier, 1=Freezer, 2=Tent, 3=Car, 4=Container, 5=Other, 6=SimpleTruck, 7=Cistern" },
        makeDate: { type: "string", description: "Manufacturing date (YYYY-MM-DD)" },
        registrationDate: { type: "string", description: "Registration date (YYYY-MM-DD)" },
        vin: { type: "string", description: "VIN code (optional)" },
        status: { type: "number", description: "Status: 0=Active (default), 1=Disassembled, 2=Sold, 3=ReRegistered, 4=Temp, 5=Unexploited, 9=Deleted" },
      },
      required: ["vehicleNumber", "vehicleModel", "type"],
    },
  },
  {
    name: "update_vehicle",
    description: `Update an existing vehicle/truck in Brunas TMS by ID. Automatically fetches the current vehicle data and merges with provided fields (only overrides what you pass).
type values: 0=VehicleCarrier, 1=Freezer, 2=Tent, 3=Car, 4=Container, 5=Other, 6=SimpleTruck, 7=Cistern.
status values: 0=Active, 1=Disassembled, 2=Sold, 3=ReRegistered, 4=Temp, 5=Unexploited, 9=Deleted.
model: plain string — the make/model name (e.g. "Daf XF"). Use search_vehicle_models to find valid names.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Vehicle ID to update" },
        number: { type: "string", description: "Vehicle plate number" },
        vehicleModel: { type: "string", description: "Model name string (e.g. 'Daf XF', 'Mercedes Benz Actros 1841')" },
        type: { type: "number", description: "Vehicle type: 0=VehicleCarrier, 1=Freezer, 2=Tent, 3=Car, 4=Container, 5=Other, 6=SimpleTruck, 7=Cistern" },
        status: { type: "number", description: "Status: 0=Active, 1=Disassembled, 2=Sold, 3=ReRegistered, 4=Temp, 5=Unexploited, 9=Deleted" },
        vin: { type: "string", description: "VIN code" },
        makeDate: { type: "string", description: "Manufacturing date (YYYY-MM-DD)" },
        registrationDate: { type: "string", description: "Registration date (YYYY-MM-DD)" },
      },
      required: ["id"],
    },
  },
  {
    name: "search_superstructure_makes",
    description: "Search trailer/superstructure makes by name query. Returns matching makes with id and make name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (partial make name, e.g. 'SCHMITZ')" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_superstructure_make",
    description: "Create a new trailer/superstructure make in Brunas TMS. Returns the created make with id and name.",
    inputSchema: {
      type: "object",
      properties: {
        make: { type: "string", description: "Make name (e.g. 'SCHMITZ')" },
      },
      required: ["make"],
    },
  },
  {
    name: "search_superstructure_models",
    description: "Search trailer/superstructure models (types) by name query. Returns matching models with id and type name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (partial model/type name, e.g. 'inta')" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_superstructure_model",
    description: "Create a new trailer/superstructure model (type) in Brunas TMS. Returns the created model with id and type name.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Model/type name (e.g. 'Intago')" },
      },
      required: ["type"],
    },
  },
  {
    name: "get_trailer",
    description: `Get a single trailer by ID from Brunas TMS.
Returns: id, number, model, vin, typeModel, xlCertificate, dyselis, trailerType, calculatedOdometer, makeDate, firstFloorFingernail, secondFloorFingernail, leasingDate, leasingRedeemedDate.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Trailer ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "find_trailers",
    description: `Search trailers in Brunas TMS with filters and pagination.
Available filter fields:
  - number (isAnyOfContains): trailer plate number, e.g. ["ABC001"]
  - trailerType (isAnyOf): 0=Autovežis, 1=Šaldytuvas, 2=Tentas, 3=Konteineris, 4=Kita, 5=Cisterna
  - model (isAnyOfContains): make/brand name, e.g. ["schmi"]
  - type (isAnyOfContains): model/type name, e.g. ["inta"]
  - vehicleTrailer (isAnyOf): array of vehicle IDs the trailer is assigned to
  - vin (isAnyOfContains): VIN code, e.g. ["WSM000"]
Returns: id, number, model, vin, type, odometer, trailerType, vehicleTrailer, leasingDate, leasingRedeemedDate.`,
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "array",
          items: filterItemSchema,
          description: "Filter items (empty array = no filter)",
        },
        page: { type: "number", description: "Page number (0-based, default 0)" },
        pageSize: { type: "number", description: "Results per page (default 25)" },
        sort: { type: "array", items: sortItemSchema, description: "Sort order" },
      },
    },
  },
  {
    name: "create_trailer",
    description: `Create a new trailer in Brunas TMS.
trailerType values: 0=Autovežis (Autocarrier), 1=Šaldytuvas (Fridge), 2=Tentas (Tilt/Tent), 3=Konteineris (Container), 4=Kita/pagalbinės (Other/Auxiliary), 5=Cisterna (Tanker).
IMPORTANT: If trailerType is not provided, do NOT guess — ask the user to choose from the list above before calling this tool.
model: object with id and model name (from search_superstructure_makes).
type: object with id and type name (from search_superstructure_models).`,
    inputSchema: {
      type: "object",
      properties: {
        trailerType: { type: "number", description: "Trailer type: 0=Autovežis (Autocarrier), 1=Šaldytuvas (Fridge), 2=Tentas (Tilt/Tent), 3=Konteineris (Container), 4=Kita/pagalbinės (Other/Auxiliary), 5=Cisterna (Tanker)" },
        model: { type: "object", description: "Make object { id, model } from search_superstructure_makes", properties: { id: { type: "number" }, model: { type: "string" } }, required: ["id", "model"] },
        type: { type: "object", description: "Type object { id, type } from search_superstructure_models", properties: { id: { type: "number" }, type: { type: "string" } }, required: ["id", "type"] },
        number: { type: "string", description: "Trailer plate number (e.g. 'ABC001')" },
        documentNumber: { type: "string", description: "Document number" },
        vin: { type: "string", description: "VIN code" },
        firstFloorFingernail: { type: "number", description: "First floor fingernail count" },
        secondFloorFingernail: { type: "number", description: "Second floor fingernail count" },
        fingernailCount: { type: "number", description: "Total fingernail count" },
        makeDate: { type: "string", description: "Manufacturing date (YYYY-MM-DD)" },
        registrationDate: { type: "string", description: "Registration date (YYYY-MM-DD)" },
        dyselis: { type: "boolean", description: "Has diesel heater (default false)" },
        leasingDate: { type: "string", description: "Leasing start date (YYYY-MM-DD, optional)" },
        leasingRedeemedDate: { type: "string", description: "Leasing redeemed date (YYYY-MM-DD, optional)" },
      },
      required: ["model", "type", "number"],
    },
  },
  {
    name: "update_trailer",
    description: `Update an existing trailer in Brunas TMS by ID. Automatically fetches the current trailer data and merges with provided fields (only overrides what you pass).
trailerType values: 0=Autovežis (Autocarrier), 1=Šaldytuvas (Fridge), 2=Tentas (Tilt/Tent), 3=Konteineris (Container), 4=Kita/pagalbinės (Other/Auxiliary), 5=Cisterna (Tanker).
model: object with id and model name (from search_superstructure_makes).
type: object with id and type name (from search_superstructure_models).`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Trailer ID to update" },
        trailerType: { type: "number", description: "Trailer type: 0=Autovežis, 1=Šaldytuvas, 2=Tentas, 3=Konteineris, 4=Kita, 5=Cisterna" },
        model: { type: "object", description: "Make object { id, model }", properties: { id: { type: "number" }, model: { type: "string" } }, required: ["id", "model"] },
        type: { type: "object", description: "Type object { id, type }", properties: { id: { type: "number" }, type: { type: "string" } }, required: ["id", "type"] },
        number: { type: "string", description: "Trailer plate number" },
        documentNumber: { type: "string", description: "Document number" },
        vin: { type: "string", description: "VIN code" },
        firstFloorFingernail: { type: "number", description: "First floor fingernail count" },
        secondFloorFingernail: { type: "number", description: "Second floor fingernail count" },
        fingernailCount: { type: "number", description: "Total fingernail count" },
        makeDate: { type: "string", description: "Manufacturing date (YYYY-MM-DD)" },
        registrationDate: { type: "string", description: "Registration date (YYYY-MM-DD)" },
        dyselis: { type: "boolean", description: "Has diesel heater" },
        leasingDate: { type: "string", description: "Leasing start date (YYYY-MM-DD, optional)" },
        leasingRedeemedDate: { type: "string", description: "Leasing redeemed date (YYYY-MM-DD, optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "hook_trailer_to_vehicle",
    description: `Create a truck-trailer link (same flow as "Pridėti priekabą" in vehicle detail).
Uses POST /api/v3/vehicle-trailers/ with vehicle/trailer resolved from IDs.
dateFrom is required in YYYY-MM-DD format. dateTo is optional (open-ended link).`,
    inputSchema: {
      type: "object",
      properties: {
        vehicleId: { type: "number", description: "Vehicle ID" },
        trailerId: { type: "number", description: "Trailer ID" },
        dateFrom: { type: "string", description: "Link start date (YYYY-MM-DD)" },
        dateTo: { type: "string", description: "Optional link end date (YYYY-MM-DD)" },
      },
      required: ["vehicleId", "trailerId", "dateFrom"],
    },
  },
  {
    name: "edit_vehicle_trailer_link",
    description: `Edit an existing truck-trailer link.
Uses PUT /api/v3/vehicle-trailers/{id}/edit with fetch-merge behavior.
Pass only fields you want to change; IDs are resolved to full objects internally.`,
    inputSchema: {
      type: "object",
      properties: {
        vehicleTrailerId: { type: "number", description: "Vehicle-trailer link ID" },
        vehicleId: { type: "number", description: "Optional replacement vehicle ID" },
        trailerId: { type: "number", description: "Optional replacement trailer ID" },
        dateFrom: { type: "string", description: "Optional replacement start date (YYYY-MM-DD)" },
        dateTo: { type: "string", description: "Optional replacement end date (YYYY-MM-DD or null)" },
      },
      required: ["vehicleTrailerId"],
    },
  },
  {
    name: "finish_vehicle_trailer_link",
    description: "Finish an active truck-trailer link by setting end date (POST /api/v3/vehicle-trailers/{id}/finish).",
    inputSchema: {
      type: "object",
      properties: {
        vehicleTrailerId: { type: "number", description: "Vehicle-trailer link ID" },
        dateTo: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["vehicleTrailerId", "dateTo"],
    },
  },
  {
    name: "delete_vehicle_trailer_link",
    description: "Delete a truck-trailer link (DELETE /api/v3/vehicle-trailers/{id}/delete).",
    inputSchema: {
      type: "object",
      properties: {
        vehicleTrailerId: { type: "number", description: "Vehicle-trailer link ID" },
      },
      required: ["vehicleTrailerId"],
    },
  },
  {
    name: "normalize_trailer_numbers",
    description: `Bulk normalize trailer plate numbers by removing all spaces.
This tool fetches each trailer and sends a full merged payload on update (safe for endpoints that reject partial payloads).
By default it stops on first failure and returns detailed failure info.`,
    inputSchema: {
      type: "object",
      properties: {
        pageSize: {
          type: "number",
          description: "Pagination size for trailer scan (default 200)",
        },
        failFast: {
          type: "boolean",
          description: "Stop on first failed update (default true)",
        },
        dryRun: {
          type: "boolean",
          description: "If true, only scans and returns candidates without updating",
        },
      },
    },
  },
  // ── Vehicle Service ─────────────────────────────────────────
  {
    name: "search_damages",
    description: `Search vehicle damages/failures in Brunas TMS.
Filter by vehicle (use "vehicle-{id}" format, e.g. "vehicle-1220" for NBO401), status, etc.
Returns damage records with id, transport, description, urgency, category, status, photos, createDate, creatorName.
Available filter fields:
  - status (isAnyOf): pending, seen, inProgress, completed, cancelled
  - transport (isAnyOf): use "vehicle-{vehicleId}" format, e.g. ["vehicle-1220"]
  - category (isAnyOf): body-work, engine, transmission, electrical, brakes, suspension, tires, other
  - urgency (isAnyOf): tolerable, urgent, critical
  - description (contains): free text search in description
  - creatorName (contains): who created the damage record
  - createDate (range): creation date`,
    inputSchema: {
      type: "object",
      properties: {
        ...datatableInputProperties,
        vehicleNumber: {
          type: "string",
          description: "Optional shortcut: vehicle plate number (e.g. 'NBO401'). Will auto-resolve to vehicle ID and add transport filter. Requires search_vehicles lookup.",
        },
      },
    },
  },
  {
    name: "register_damage",
    description: `Register a vehicle damage/failure in Brunas TMS.
Urgency values: tolerable, urgent, critical
Category values: body-work, engine, transmission, electrical, brakes, suspension, tires, other`,
    inputSchema: {
      type: "object",
      properties: {
        vehicleId: { type: "number", description: "Vehicle ID (from search_vehicles or carriage data)" },
        description: { type: "string", description: "Damage description" },
        urgency: { type: "string", description: "Urgency: tolerable, urgent, or critical (default: tolerable)" },
        category: { type: "string", description: "Category: body-work, engine, transmission, electrical, brakes, suspension, tires, other (default: body-work)" },
        trailerId: { type: "number", description: "Trailer ID if damage is on trailer (optional)" },
      },
      required: ["vehicleId", "description"],
    },
  },
  {
    name: "upload_image",
    description: `Upload an image file to Brunas TMS. Returns the upload ID and full URL path.
The returned fullPath can be used to construct the photo URL: https://upload.brunas.lt/read/<fullPath>`,
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute local path to the image file" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "update_damage",
    description: `Update an existing vehicle damage/failure record (e.g. to attach photos).
Send the full record payload including photos array with URLs like: https://upload.brunas.lt/read/<fullPath>`,
    inputSchema: {
      type: "object",
      properties: {
        damageId: { type: "string", description: "The UUID of the damage record to update" },
        data: { type: "object", description: "Full or partial damage record payload (urgency, category, vehicleId, trailerId, description, status, photos)" },
      },
      required: ["damageId", "data"],
    },
  },
];

// ─── MCP Server ──────────────────────────────────────────────────────

const server = new Server(
  {
    name: "brunas-tms-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: toolArgs } = request.params;
  const args = (toolArgs ?? {}) as Record<string, unknown>;

  try {
    // ── Login / client selection tools (handled before getClient) ───
    if (toolName === "brunas_login") {
      // Reset all auth state
      storedJwt = null;
      resolvedClients = null;
      selectedClientId = null;
      brunasClient = null;

      const { jwt } = await performBrowserLogin();
      storedJwt = jwt;

      const { isSuper, clients } = await resolveClients(jwt);
      resolvedClients = clients;

      if (clients.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Logged in, but no accessible clients found for this account." }],
        };
      }

      if (clients.length === 1) {
        selectedClientId = clients[0].id;
        return {
          content: [{
            type: "text" as const,
            text: `Logged in. Selected client: ${clients[0].name} (https://${clients[0].domain})`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: formatClientSelectionMessage(clients, {
            title: "Logged in. Multiple clients available.",
            instruction: "Call brunas_select_client with the exact client name or domain to continue.",
            isSuper,
          }),
        }],
      };
    }

    if (toolName === "brunas_logout") {
      if (!storedJwt) {
        return {
          content: [{ type: "text" as const, text: "Already logged out." }],
        };
      }

      // Call the Brunas logout endpoint to invalidate the JWT server-side
      try {
        await axios.post(
          "https://savitarna.brunas.lt/auth/auth/logout?cookie_domain=.brunas.lt",
          {},
          { headers: { Cookie: `jwt=${storedJwt}` } }
        );
      } catch {
        // Best-effort — clear local state regardless
      }

      // Clear all local auth state
      storedJwt = null;
      resolvedClients = null;
      selectedClientId = null;
      brunasClient = null;

      return {
        content: [{ type: "text" as const, text: "Logged out of Brunas TMS." }],
      };
    }

    if (toolName === "brunas_select_client") {
      if (!storedJwt) {
        throw new McpError(ErrorCode.InvalidRequest, "Not logged in. Call brunas_login first.");
      }

      const clientId = args.clientId as string;
      if (!clientId) {
        throw new McpError(ErrorCode.InvalidRequest, "clientId is required");
      }

      // Re-resolve if needed
      if (!resolvedClients) {
        const { clients } = await resolveClients(storedJwt);
        resolvedClients = clients;
      }

      const match = resolvedClients.find(
        (c) =>
          c.id === clientId ||
          c.name.toLowerCase() === clientId.toLowerCase() ||
          c.domain.toLowerCase() === clientId.toLowerCase()
      );
      if (!match) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Client "${clientId}" not found.\n\n${formatClientSelectionMessage(resolvedClients, {
            title: "Available clients:",
            instruction: "Retry brunas_select_client with one of the names or domains above.",
          })}`
        );
      }

      selectedClientId = match.id;
      brunasClient = null; // Force re-creation with the new client URL

      return {
        content: [{
          type: "text" as const,
          text: `Selected client: ${match.name} (https://${match.domain})`,
        }],
      };
    }

    const client = await getClient();

    switch (toolName) {
      // ── Find carriages ───────────────────────────────────────
      case "find_carriages": {
        const data = await client.findCarriages(
          (args.filters as Array<{ field: string; value: string | string[] | number; operator: string }>) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as Array<{ field: string; sort: "asc" | "desc" | null }> | undefined,
          args.quickFilter as string[] | undefined
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Find drivers ─────────────────────────────────────────
      case "find_drivers": {
        const quickFilter = args.quickFilter as string[] | undefined;
        const searchDriver = args.searchDriver as string | undefined;
        const effectiveQuickFilter = quickFilter ?? (
          typeof searchDriver === "string" && searchDriver.trim()
            ? [searchDriver.trim()]
            : undefined
        );
        const data = await client.findDrivers(
          (args.filters as Array<{ field: string; value: string | string[] | number; operator: string }>) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as Array<{ field: string; sort: "asc" | "desc" | null }> | undefined,
          effectiveQuickFilter
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Find vehicles ────────────────────────────────────────
      case "find_vehicles": {
        const data = await client.findVehicles(
          (args.filters as Array<{ field: string; value: string | string[] | number; operator: string }>) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as Array<{ field: string; sort: "asc" | "desc" | null }> | undefined,
          args.quickFilter as string[] | undefined
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Get single carriage ──────────────────────────────────
      case "get_carriage": {
        const id = args.id as string;
        if (!id) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }
        const data = await client.getCarriage(id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Get single driver ────────────────────────────────────
      case "get_driver": {
        const id = args.id as string;
        if (!id) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }
        const data = await client.getDriver(id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Create driver ────────────────────────────────────────
      case "create_driver": {
        const payload = args.data as Record<string, unknown>;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new McpError(ErrorCode.InvalidRequest, "data object is required");
        }
        const firstName = payload.firstName;
        const lastName = payload.lastName;
        if (typeof firstName !== "string" || !firstName.trim()) {
          throw new McpError(ErrorCode.InvalidRequest, "data.firstName is required");
        }
        if (typeof lastName !== "string" || !lastName.trim()) {
          throw new McpError(ErrorCode.InvalidRequest, "data.lastName is required");
        }
        const data = await client.createDriver(payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Update driver ────────────────────────────────────────
      case "update_driver": {
        const rawId = args.id;
        if (rawId === undefined || rawId === null || rawId === "") {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }

        const updates = args.updates as Record<string, unknown>;
        if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
          throw new McpError(ErrorCode.InvalidRequest, "updates object is required");
        }

        const driverId = String(rawId);
        const existingResponse = await client.getDriver(driverId);
        const existing = unwrapApiData(existingResponse);

        const payload: Record<string, unknown> = {
          ...existing,
          ...updates,
          id: existing.id ?? rawId,
        };

        const data = await client.updateDriver(driverId, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      case "cadency_search": {
        let filters = (args.filters as Array<{ field: string; value: string | string[] | number | number[]; operator: string }>) ?? [];
        let quickFilter = args.quickFilter as string[] | undefined;
        const page = (args.page as number) ?? 0;
        const pageSize = (args.pageSize as number) ?? 25;
        const sort = args.sort as Array<{ field: string; sort: "asc" | "desc" | null }> | undefined;

        const vehicleIdArg = args.vehicleId as number | undefined;
        if (typeof vehicleIdArg === "number" && Number.isFinite(vehicleIdArg)) {
          filters = [
            ...filters,
            { field: "vehicle", operator: "isAnyOf", value: [vehicleIdArg] },
          ];
        }

        const vehicleNumberRaw = args.vehicleNumber as string | undefined;
        const normalizedVehicle = vehicleNumberRaw?.replace(/\s+/g, "").toUpperCase();
        if (normalizedVehicle) {
          const searchResult = await client.searchActiveVehicles(normalizedVehicle) as { data?: Array<{ id: number; number: string }> };
          const vehicles = searchResult.data ?? [];
          const match = vehicles.find((v) => v.number.replace(/\s+/g, "").toUpperCase() === normalizedVehicle) ?? vehicles[0];
          if (!match) {
            return {
              content: [{ type: "text" as const, text: `Vehicle "${vehicleNumberRaw}" not found.` }],
            };
          }
          filters = [
            ...filters,
            { field: "vehicle", operator: "isAnyOf", value: [match.id] },
          ];
        }

        const driverIdArg = args.driverId as number | undefined;
        if (typeof driverIdArg === "number" && Number.isFinite(driverIdArg)) {
          filters = [
            ...filters,
            { field: "driver", operator: "isAnyOf", value: [driverIdArg] },
          ];
        }

        const driverName = args.driverName as string | undefined;
        if (driverName && (!quickFilter || quickFilter.length === 0)) {
          quickFilter = [driverName];
        }

        const statuses: string[] = [];
        const rawStatus = args.status as string | undefined;
        if (rawStatus) statuses.push(rawStatus);
        const rawStatuses = args.statuses as string[] | undefined;
        if (Array.isArray(rawStatuses)) {
          for (const st of rawStatuses) {
            if (typeof st === "string") statuses.push(st);
          }
        }
        if (statuses.length) {
          filters = [
            ...filters,
            { field: "status", operator: "isAnyOf", value: statuses },
          ];
        }

        const rangeStart = args.dateFrom as string | undefined;
        if (rangeStart) {
          filters = [
            ...filters,
            { field: "dateFrom", operator: "onOrAfter", value: assertIsoDate(rangeStart, "dateFrom") },
          ];
        }
        const rangeEnd = args.dateTo as string | undefined;
        if (rangeEnd) {
          filters = [
            ...filters,
            { field: "dateTo", operator: "onOrBefore", value: assertIsoDate(rangeEnd, "dateTo") },
          ];
        }

        const data = await client.findCadencies(
          filters,
          page,
          pageSize,
          sort,
          quickFilter
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      case "create_cadency": {
        const dataArg = args.data as Record<string, unknown>;
        if (!dataArg || typeof dataArg !== "object" || Array.isArray(dataArg)) {
          throw new McpError(ErrorCode.InvalidRequest, "data object is required");
        }

        const driverId = Number(dataArg.driverId);
        const vehicleId = Number(dataArg.vehicleId);
        if (!Number.isFinite(driverId)) {
          throw new McpError(ErrorCode.InvalidRequest, "data.driverId must be a number");
        }
        if (!Number.isFinite(vehicleId)) {
          throw new McpError(ErrorCode.InvalidRequest, "data.vehicleId must be a number");
        }

        const dateFromIso = normalizeCadencyDateTime(dataArg.dateFrom, "data.dateFrom", true);
        const dateToIso = normalizeCadencyDateTime(dataArg.dateTo, "data.dateTo", false);
        const dateLeavingIso = normalizeCadencyDateTime(dataArg.dateLeaving, "data.dateLeaving", false);
        const dateReturnIso = normalizeCadencyDateTime(dataArg.dateReturn, "data.dateReturn", false);
        const middleman = normalizeMiddlemanInput(dataArg.middleman ?? dataArg.middlemanId, "data.middleman");
        const middlemanFrom = normalizeMiddlemanInput(
          dataArg.middlemanFrom ?? dataArg.middlemanFromId,
          "data.middlemanFrom"
        );

        const payload: Record<string, unknown> = {
          ...dataArg,
          id: dataArg.id ?? null,
          driverId,
          vehicleId,
          dateFrom: dateFromIso,
          dateTo: dateToIso,
          dateLeaving: dateLeavingIso,
          dateReturn: dateReturnIso,
          middleman,
          middlemanFrom,
        };
        delete payload.middlemanId;
        delete payload.middlemanFromId;

        const data = await client.createCadency(payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      case "update_cadency": {
        const cadencyId = args.id as number;
        if (!Number.isFinite(cadencyId)) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required and must be a number");
        }

        const updates = args.updates as Record<string, unknown>;
        if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
          throw new McpError(ErrorCode.InvalidRequest, "updates object is required");
        }

        const existingResponse = await client.getCadency(cadencyId);
        const existing = unwrapApiData(existingResponse);
        const payload: Record<string, unknown> = {
          ...existing,
          ...updates,
          id: existing.id ?? cadencyId,
        };

        if (updates.driverId !== undefined) {
          const driverId = Number(updates.driverId);
          if (!Number.isFinite(driverId)) {
            throw new McpError(ErrorCode.InvalidRequest, "updates.driverId must be a number");
          }
          payload.driverId = driverId;
        }

        if (updates.vehicleId !== undefined) {
          const vehicleId = Number(updates.vehicleId);
          if (!Number.isFinite(vehicleId)) {
            throw new McpError(ErrorCode.InvalidRequest, "updates.vehicleId must be a number");
          }
          payload.vehicleId = vehicleId;
        }

        if (updates.dateFrom !== undefined) {
          payload.dateFrom = normalizeCadencyDateTime(updates.dateFrom, "updates.dateFrom", true);
        }
        if (updates.dateTo !== undefined) {
          payload.dateTo = normalizeCadencyDateTime(updates.dateTo, "updates.dateTo", false);
        }
        if (updates.dateLeaving !== undefined) {
          payload.dateLeaving = normalizeCadencyDateTime(updates.dateLeaving, "updates.dateLeaving", false);
        }
        if (updates.dateReturn !== undefined) {
          payload.dateReturn = normalizeCadencyDateTime(updates.dateReturn, "updates.dateReturn", false);
        }

        if ("middleman" in updates || "middlemanId" in updates) {
          payload.middleman = normalizeMiddlemanInput(
            updates.middleman ?? updates.middlemanId,
            "updates.middleman"
          );
        }
        if ("middlemanFrom" in updates || "middlemanFromId" in updates) {
          payload.middlemanFrom = normalizeMiddlemanInput(
            updates.middlemanFrom ?? updates.middlemanFromId,
            "updates.middlemanFrom"
          );
        }

        delete payload.middlemanId;
        delete payload.middlemanFromId;

        const data = await client.updateCadency(cadencyId, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Get single vehicle ───────────────────────────────────
      case "get_vehicle": {
        const id = args.id as string;
        if (!id) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }
        const data = await client.getVehicle(id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Search vehicles (active first, then fallback to all) ───
      case "search_vehicles": {
        const query = args.query as string;
        if (!query) {
          throw new McpError(ErrorCode.InvalidRequest, "query is required");
        }
        const activeData = await client.searchActiveVehicles(query) as { data?: unknown[] };
        if (activeData.data && activeData.data.length > 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(activeData, null, 2) }],
          };
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
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      // ── Search vehicle models ─────────────────────────────────
      case "search_vehicle_models": {
        const query = args.query as string;
        if (!query) {
          throw new McpError(ErrorCode.InvalidRequest, "query is required");
        }
        const data = await client.searchVehicleModels(query);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Get single vehicle by ID (v2) ────────────────────────
      case "get_vehicle_by_id": {
        const id = args.id as number;
        if (!id) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }
        const data = await client.getVehicleById(id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Create vehicle ────────────────────────────────────────
      case "create_vehicle": {
        const vehicleNumber = args.vehicleNumber as string;
        const vehicleModel = (args.vehicleModel as string) || null;
        const vehicleType = args.type as number;
        if (!vehicleNumber || vehicleType === undefined) {
          throw new McpError(ErrorCode.InvalidRequest, "vehicleNumber and type are required");
        }
        // Create with model=null (API rejects unknown model strings with 500)
        const createPayload: Record<string, unknown> = {
          id: null,
          name: "",
          vehicleNumber: vehicleNumber.replace(/\s+/g, ""),
          model: null,
          type: vehicleType,
          status: (args.status as number) ?? 0,
          makeDate: (args.makeDate as string) ?? null,
          registrationDate: (args.registrationDate as string) ?? null,
          vehicleVin: (args.vin as string) ?? null,
          superstructure: { model: null, type: null, firstFloorFingernail: 0, secondFloorFingernail: 0 },
          tags: [],
          owner: null,
          license: null,
          licenseNr: null,
          manager: null,
          managerId: null,
          phone: null,
          emissionType: 1,
          co2EmissionClass: 0,
          engineType: 0,
          fuelType: 0,
          fuelCardPin: null,
          tankCapacity: null,
          telemetrySource: null,
          locationFromApp: false,
          rivileDepartmentCode: "",
          rivileCostCenterCode: "",
          superStructureMakeDate: null,
          cabinType: 0,
          fuelRateSummer: null,
          fuelRateWinter: null,
          leasingDate: null,
          leasingRedeemedDate: null,
        };
        const createResult = await client.createVehicle(createPayload);
        const created = ((createResult as Record<string, unknown>).data ?? createResult) as Record<string, unknown>;
        const newId = created.id as number;

        // If model was provided, update the vehicle to set it (uses fetch-merge)
        if (vehicleModel && newId) {
          const existingResponse = await client.getVehicle(String(newId));
          const existing = ((existingResponse as Record<string, unknown>).data ?? existingResponse) as Record<string, unknown>;
          const updatePayload = { ...existing, id: newId, model: vehicleModel };
          const updateResult = await client.updateVehicle(newId, updatePayload);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(updateResult, null, 2) }],
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(createResult, null, 2) }],
        };
      }

      // ── Update vehicle ────────────────────────────────────────
      case "update_vehicle": {
        const vehicleId = args.id as number;
        if (!vehicleId) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }

        // Fetch existing vehicle (v3/form) to preserve all fields
        const existingVehicleResponse = await client.getVehicle(String(vehicleId));
        const existingVehicle = ((existingVehicleResponse as Record<string, unknown>).data ?? existingVehicleResponse) as Record<string, unknown>;

        // Start from existing data, override only provided fields
        const vehiclePayload: Record<string, unknown> = { ...existingVehicle, id: vehicleId };
        if (args.number !== undefined) vehiclePayload.number = (args.number as string).replace(/\s+/g, "");
        if (args.vehicleModel !== undefined) vehiclePayload.model = args.vehicleModel as string;
        if (args.type !== undefined) vehiclePayload.type = args.type;
        if (args.status !== undefined) vehiclePayload.status = args.status;
        if (args.vin !== undefined) vehiclePayload.vin = args.vin;
        if (args.makeDate !== undefined) vehiclePayload.makeDate = args.makeDate;
        if (args.registrationDate !== undefined) vehiclePayload.registrationDate = args.registrationDate;
        const data = await client.updateVehicle(vehicleId, vehiclePayload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Search superstructure makes ──────────────────────────
      case "search_superstructure_makes": {
        const query = args.query as string;
        if (!query) {
          throw new McpError(ErrorCode.InvalidRequest, "query is required");
        }
        const data = await client.searchSuperStructureMakes(query);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Create superstructure make ───────────────────────────
      case "create_superstructure_make": {
        const make = args.make as string;
        if (!make) {
          throw new McpError(ErrorCode.InvalidRequest, "make is required");
        }
        const data = await client.createSuperStructureMake(make);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Search superstructure models ─────────────────────────
      case "search_superstructure_models": {
        const query = args.query as string;
        if (!query) {
          throw new McpError(ErrorCode.InvalidRequest, "query is required");
        }
        const data = await client.searchSuperStructureModels(query);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Create superstructure model ──────────────────────────
      case "create_superstructure_model": {
        const type = args.type as string;
        if (!type) {
          throw new McpError(ErrorCode.InvalidRequest, "type is required");
        }
        const data = await client.createSuperStructureModel(type);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Find trailers ─────────────────────────────────────────
      case "find_trailers": {
        const data = await client.findTrailers(
          (args.filters as Array<{ field: string; value: string | string[] | number | number[]; operator: string }>) ?? [],
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 25,
          args.sort as Array<{ field: string; sort: "asc" | "desc" | null }> | undefined
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Get single trailer ─────────────────────────────────────
      case "get_trailer": {
        const id = args.id as number;
        if (!id) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }
        const data = await client.getTrailer(id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Create trailer ────────────────────────────────────────
      case "create_trailer": {
        const rawModel = args.model;
        const rawType = args.type;
        const model = typeof rawModel === "string" ? JSON.parse(rawModel) : rawModel;
        const type = typeof rawType === "string" ? JSON.parse(rawType) : rawType;
        const payload = {
          id: null,
          trailerType: args.trailerType as number,
          model: model as { id: number; model: string },
          type: type as { id: number; type: string },
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
        const data = await client.createTrailer(payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Update trailer ────────────────────────────────────────
      case "update_trailer": {
        const trailerId = args.id as number;
        if (!trailerId) {
          throw new McpError(ErrorCode.InvalidRequest, "id is required");
        }

        // Fetch existing trailer to preserve all fields
        const existingResponse = await client.getTrailer(trailerId);
        const existing = ((existingResponse as Record<string, unknown>).data ?? existingResponse) as Record<string, unknown>;

        const rawModel = args.model;
        const rawType = args.type;
        const model = rawModel ? (typeof rawModel === "string" ? JSON.parse(rawModel) : rawModel) : undefined;
        const type = rawType ? (typeof rawType === "string" ? JSON.parse(rawType) : rawType) : undefined;

        // Start from existing data, override only provided fields
        const payload: Record<string, unknown> = { ...existing, id: trailerId };
        if (args.trailerType !== undefined) payload.trailerType = args.trailerType;
        if (model !== undefined) payload.model = model;
        if (type !== undefined) payload.type = type;
        if (args.number !== undefined) payload.number = (args.number as string).replace(/\s+/g, "");
        if (args.documentNumber !== undefined) payload.documentNumber = args.documentNumber;
        if (args.vin !== undefined) payload.vin = args.vin;
        if (args.firstFloorFingernail !== undefined) payload.firstFloorFingernail = args.firstFloorFingernail;
        if (args.secondFloorFingernail !== undefined) payload.secondFloorFingernail = args.secondFloorFingernail;
        if (args.fingernailCount !== undefined) payload.fingernailCount = args.fingernailCount;
        if (args.makeDate !== undefined) payload.makeDate = args.makeDate;
        if (args.registrationDate !== undefined) payload.registrationDate = args.registrationDate;
        if (args.dyselis !== undefined) payload.dyselis = args.dyselis;
        if (args.leasingDate !== undefined) payload.leasingDate = args.leasingDate;
        if (args.leasingRedeemedDate !== undefined) payload.leasingRedeemedDate = args.leasingRedeemedDate;
        const data = await client.updateTrailer(trailerId, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Hook trailer to vehicle ────────────────────────────
      case "hook_trailer_to_vehicle": {
        const vehicleId = args.vehicleId as number;
        const trailerId = args.trailerId as number;
        if (!vehicleId || !trailerId) {
          throw new McpError(ErrorCode.InvalidRequest, "vehicleId and trailerId are required");
        }

        const dateFrom = assertIsoDate(args.dateFrom, "dateFrom");
        const dateToArg = args.dateTo as string | null | undefined;
        if (dateToArg !== undefined && dateToArg !== null) {
          assertIsoDate(dateToArg, "dateTo");
        }

        const vehicleResponse = await client.getVehicle(String(vehicleId));
        const trailerResponse = await client.getTrailer(trailerId);
        const vehicle = unwrapApiData(vehicleResponse);
        if (vehicle.expedition === undefined) {
          vehicle.expedition = false;
        }
        const trailer = unwrapApiData(trailerResponse);

        const payload: Record<string, unknown> = {
          vehicle,
          trailer,
          dateFrom,
          dateTo: dateToArg ?? null,
        };

        const precheck = await client.getIntersectingVehicleTrailers(trailerId, {
          dateFrom,
          dateTo: dateToArg ?? null,
          skipVehicleId: vehicleId,
          skipTrailerId: null,
        });

        const data = await client.createVehicleTrailer(payload);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ precheck, data }, null, 2),
          }],
        };
      }

      // ── Edit vehicle-trailer link ──────────────────────────
      case "edit_vehicle_trailer_link": {
        const vehicleTrailerId = args.vehicleTrailerId as number;
        if (!vehicleTrailerId) {
          throw new McpError(ErrorCode.InvalidRequest, "vehicleTrailerId is required");
        }

        const existingResponse = await client.getVehicleTrailer(vehicleTrailerId);
        const existing = unwrapApiData(existingResponse);
        const payload: Record<string, unknown> = { ...existing };

        if (args.vehicleId !== undefined) {
          const vehicleId = args.vehicleId as number;
          if (!vehicleId) {
            throw new McpError(ErrorCode.InvalidRequest, "vehicleId must be a valid number");
          }
          const vehicleResponse = await client.getVehicle(String(vehicleId));
          const vehicle = unwrapApiData(vehicleResponse);
          if (vehicle.expedition === undefined) {
            vehicle.expedition = false;
          }
          payload.vehicle = vehicle;
        }

        if (args.trailerId !== undefined) {
          const trailerId = args.trailerId as number;
          if (!trailerId) {
            throw new McpError(ErrorCode.InvalidRequest, "trailerId must be a valid number");
          }
          const trailerResponse = await client.getTrailer(trailerId);
          payload.trailer = unwrapApiData(trailerResponse);
        }

        if (args.dateFrom !== undefined) {
          payload.dateFrom = assertIsoDate(args.dateFrom, "dateFrom");
        }

        if (args.dateTo !== undefined) {
          const dateTo = args.dateTo as string | null;
          if (dateTo !== null) {
            payload.dateTo = assertIsoDate(dateTo, "dateTo");
          } else {
            payload.dateTo = null;
          }
        }

        const effectiveTrailer = payload.trailer as Record<string, unknown> | undefined;
        const effectiveVehicle = payload.vehicle as Record<string, unknown> | undefined;
        const effectiveTrailerId = Number(effectiveTrailer?.id);
        const effectiveVehicleId = Number(effectiveVehicle?.id);
        const effectiveDateFrom = payload.dateFrom as string;
        const effectiveDateTo = (payload.dateTo as string | null | undefined) ?? null;

        if (!effectiveTrailerId || !effectiveVehicleId || !effectiveDateFrom) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Unable to resolve trailer, vehicle, or dateFrom for intersecting precheck"
          );
        }

        const precheck = await client.getIntersectingVehicleTrailers(effectiveTrailerId, {
          dateFrom: effectiveDateFrom,
          dateTo: effectiveDateTo,
          skipVehicleId: effectiveVehicleId,
          skipTrailerId: vehicleTrailerId,
        });

        const data = await client.editVehicleTrailer(vehicleTrailerId, payload);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ precheck, data }, null, 2),
          }],
        };
      }

      // ── Finish vehicle-trailer link ────────────────────────
      case "finish_vehicle_trailer_link": {
        const vehicleTrailerId = args.vehicleTrailerId as number;
        if (!vehicleTrailerId) {
          throw new McpError(ErrorCode.InvalidRequest, "vehicleTrailerId is required");
        }

        const dateTo = assertIsoDate(args.dateTo, "dateTo");
        const data = await client.finishVehicleTrailer(vehicleTrailerId, { dateTo });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Delete vehicle-trailer link ────────────────────────
      case "delete_vehicle_trailer_link": {
        const vehicleTrailerId = args.vehicleTrailerId as number;
        if (!vehicleTrailerId) {
          throw new McpError(ErrorCode.InvalidRequest, "vehicleTrailerId is required");
        }

        const data = await client.deleteVehicleTrailer(vehicleTrailerId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      case "normalize_trailer_numbers": {
        const pageSize = Math.max(1, ((args.pageSize as number) ?? 200));
        const failFast = (args.failFast as boolean) ?? true;
        const dryRun = (args.dryRun as boolean) ?? false;

        const candidates: Array<{ id: number; from: string; to: string }> = [];
        let page = 0;
        let total = 0;

        while (true) {
          const listResponse = await client.findTrailers(
            [],
            page,
            pageSize,
            [{ field: "id", sort: "asc" }]
          ) as { data?: Array<{ id: number; number: string | null }> };

          const rows = listResponse.data ?? [];
          total += rows.length;

          for (const row of rows) {
            const from = String(row.number ?? "");
            const to = from.replace(/\s+/g, "");
            if (to !== from) {
              candidates.push({ id: row.id, from, to });
            }
          }

          if (rows.length < pageSize) break;
          page += 1;
        }

        if (dryRun) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                mode: "dry-run",
                total,
                candidates: candidates.length,
                sample: candidates.slice(0, 25),
              }, null, 2),
            }],
          };
        }

        let updated = 0;
        const failures: Array<{
          id: number;
          from: string;
          to: string;
          status: number | null;
          message: string;
          response: unknown;
        }> = [];

        for (const candidate of candidates) {
          try {
            const existingResponse = await client.getTrailer(candidate.id);
            const existing = unwrapApiData(existingResponse);
            const payload: Record<string, unknown> = {
              ...existing,
              id: candidate.id,
              number: candidate.to,
            };

            await client.updateTrailer(candidate.id, payload);
            updated += 1;
          } catch (error: unknown) {
            const err = error as {
              message?: string;
              response?: { status?: number; data?: unknown };
            };
            const failure = {
              id: candidate.id,
              from: candidate.from,
              to: candidate.to,
              status: err.response?.status ?? null,
              message: err.message ?? String(error),
              response: err.response?.data ?? null,
            };
            failures.push(failure);

            if (failFast) {
              break;
            }
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              mode: "update",
              total,
              candidates: candidates.length,
              updated,
              failed: failures.length,
              failFast,
              failures,
            }, null, 2),
          }],
        };
      }

      // ── Search damages ───────────────────────────────────────
      case "search_damages": {
        let filters = (args.filters as Array<{ field: string; value: string | string[] | number | number[]; operator: string }>) ?? [];
        const vehicleNumber = args.vehicleNumber as string | undefined;
        if (vehicleNumber) {
          const searchResult = await client.searchActiveVehicles(vehicleNumber) as { data?: Array<{ id: number; number: string }> };
          const vehicles = searchResult.data ?? [];
          const match = vehicles.find(
            (v) => v.number.toUpperCase() === vehicleNumber.toUpperCase()
          ) ?? vehicles[0];
          if (!match) {
            return {
              content: [{ type: "text" as const, text: `Vehicle "${vehicleNumber}" not found.` }],
            };
          }
          filters = [
            ...filters,
            { field: "transport", operator: "isAnyOf", value: [`vehicle-${match.id}`] },
          ];
        }
        const data = await client.searchDamages(
          filters,
          (args.page as number) ?? 0,
          (args.pageSize as number) ?? 100,
          args.sort as Array<{ field: string; sort: "asc" | "desc" | null }> | undefined
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      // ── Register vehicle damage ──────────────────────────────
      case "register_damage": {
        const vehicleId = args.vehicleId as number;
        const description = args.description as string;
        if (!vehicleId || !description) {
          throw new McpError(ErrorCode.InvalidRequest, "vehicleId and description are required");
        }
        const data = await client.registerVehicleDamage({
          vehicleId,
          description,
          urgency: (args.urgency as string) ?? "tolerable",
          category: (args.category as string) ?? "body-work",
          trailerId: (args.trailerId as number) ?? null,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      case "upload_image": {
        const filePath = args.filePath as string;
        if (!filePath) {
          throw new McpError(ErrorCode.InvalidRequest, "filePath is required");
        }
        const data = await client.uploadImage(filePath);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      case "update_damage": {
        const damageId = args.damageId as string;
        const payload = args.data as Record<string, unknown>;
        if (!damageId || !payload) {
          throw new McpError(ErrorCode.InvalidRequest, "damageId and data are required");
        }
        const data = await client.updateVehicleDamage(damageId, payload);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${toolName}`
        );
    }
  } catch (error: unknown) {
    if (error instanceof McpError &&
      error.message.includes("Multiple clients available and none is selected.")) {
      return {
        content: [{ type: "text" as const, text: error.message }],
      };
    }

    if (error instanceof McpError) throw error;
    // Extract Axios response details if available
    const axiosErr = error as { response?: { status?: number; data?: unknown } };
    if (axiosErr.response?.data) {
      const detail = typeof axiosErr.response.data === "string"
        ? axiosErr.response.data
        : JSON.stringify(axiosErr.response.data);
      throw new McpError(ErrorCode.InternalError, `${axiosErr.response.status}: ${detail}`);
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, msg);
  }
});

// ─── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Brunas TMS MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
