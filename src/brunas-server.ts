#!/usr/bin/env node

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BrunasApiClient } from "./brunas-api.js";

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

// Lazy-initialised API client (login on first tool call)
let brunasClient: BrunasApiClient | null = null;

function getClient(): BrunasApiClient {
  if (!brunasClient) {
    const email = process.env.BRUNAS_EMAIL;
    const password = process.env.BRUNAS_PASSWORD;
    const clientUrl = process.env.BRUNAS_CLIENT_URL;

    if (!email || !password || !clientUrl) {
      throw new McpError(
        ErrorCode.InternalError,
        "Missing BRUNAS_EMAIL, BRUNAS_PASSWORD, or BRUNAS_CLIENT_URL in environment"
      );
    }

    brunasClient = new BrunasApiClient(email, password, clientUrl);
  }
  return brunasClient;
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

const DRIVER_FIELDS_DOC = `Driver search supports quick text filter (searches across name fields).
Use quickFilter parameter for text search.`;

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
      properties: datatableInputProperties,
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
    name: "get_vehicle",
    description: "Get full details of a single vehicle by ID.",
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
    description: "Search active vehicles by plate number or name query. Returns matching vehicles with id, number, name, vin, owner, manager, etc. Use this to find vehicle IDs for carriage filtering.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (partial plate number or name, e.g. 'nb', 'LBK608')" },
      },
      required: ["query"],
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

const server = new Server({
  name: "brunas-tms-mcp",
  version: "1.0.0",
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: toolArgs } = request.params;
  const args = (toolArgs ?? {}) as Record<string, unknown>;

  try {
    const client = getClient();

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
        const data = await client.findDrivers(
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

      // ── Search active vehicles ────────────────────────────────
      case "search_vehicles": {
        const query = args.query as string;
        if (!query) {
          throw new McpError(ErrorCode.InvalidRequest, "query is required");
        }
        const data = await client.searchActiveVehicles(query);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
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
    if (error instanceof McpError) throw error;
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
