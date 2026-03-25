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
    description: `Update an existing trailer in Brunas TMS by ID. Send the full trailer payload.
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
