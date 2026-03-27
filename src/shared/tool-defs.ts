/**
 * Shared tool definitions for Brunas TMS and BSS Accounting.
 * Used by both the MCP servers (stdio) and the agent HTTP server (OpenAI-compatible).
 * Derived from brunas-server.ts and bss-server.ts tool schemas.
 */

// ─── Schema fragments ────────────────────────────────────────────────

export const filterItemSchema = {
  type: "object",
  properties: {
    field: { type: "string", description: "Field name to filter on" },
    value: { description: "Filter value (string, number, or array for isAnyOf)" },
    operator: {
      type: "string",
      description: "Operator: contains, equals, startsWith, endsWith, isAnyOf, range",
    },
  },
  required: ["field", "value", "operator"],
};

export const sortItemSchema = {
  type: "object",
  properties: {
    field: { type: "string" },
    sort: { type: "string", enum: ["asc", "desc"] },
  },
  required: ["field", "sort"],
};

export const datatableInputProperties = {
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
  pageSize: { type: "number", description: "Results per page (default 25)" },
  sort: { type: "array", items: sortItemSchema, description: "Sort order" },
};

// ─── Filter field documentation ──────────────────────────────────────

const CARRIAGE_FIELDS_DOC = `Available filter fields for carriages:
  - status (isAnyOf): draft, confirmed, inProgress, finished, invoiced, cancelled
  - date (range): loading date
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
  - vehicle (isAnyOf): array of vehicle IDs (numbers)`;

const VEHICLE_FIELDS_DOC = `Available filter fields for vehicles:
  - status (isAnyOf): 0=Active, 1=Disassembled, 2=Sold, 3=ReRegistered, 4=Temp, 5=Unexploited, 9=Deleted
  - type (isAnyOf): 0=VehicleCarrier, 1=Freezer, 2=Tent, 3=Car, 4=Container, 5=Other, 6=SimpleTruck, 7=Cistern
  - driver (contains): driver name
  - trailerNumber (contains): trailer plate number
  - tags (isAnyOf): tag values
  - manager (isAnyOf): transport manager
  - middleman (isAnyOf): license owner`;

const DRIVER_FIELDS_DOC = `Driver search via quickFilter parameter for text search across driver name fields.`;

const CADENCY_FIELDS_DOC = `Available filter fields for cadencies (driver-vehicle timelines):
  - status (isAnyOf): planning, current, ended
  - vehicle (isAnyOf): array of vehicle IDs (numbers)
  - driver (isAnyOf): array of driver IDs (numbers)
  - dateFrom (onOrAfter/onOrBefore): start date range
  - dateTo (onOrAfter/onOrBefore): end date range
  - company / fromCompany (contains): company name text search`;

// ─── Form field schemas ──────────────────────────────────────────────

const driverFormFieldProperties = {
  id: { type: "number" },
  firstName: { type: "string" },
  lastName: { type: "string" },
  personalCode: { type: "string" },
  birthday: { type: "string", description: "Date in YYYY-MM-DD format" },
  nationality: { type: "string" },
  language: { type: "string", description: "lt, en, de, fr, ru, pl" },
  email: { type: "string" },
  status: { type: "boolean" },
  tags: { type: "array", items: { type: "string" } },
  employmentDate: { type: "string", description: "Date in YYYY-MM-DD format" },
  dismissDate: { type: "string", description: "Date in YYYY-MM-DD format" },
  phone: { type: "string" },
  phonePersonal: { type: "string" },
  homeAddress: { type: "string" },
  accountNumber: { type: "string" },
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

// ─── Tool definition interface ───────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── Brunas TMS tool definitions ─────────────────────────────────────

export const BRUNAS_TOOL_DEFS: ToolDef[] = [
  {
    name: "find_carriages",
    description: `Search carriages (transport trips) in Brunas TMS with filters and pagination.\n${CARRIAGE_FIELDS_DOC}`,
    inputSchema: { type: "object", properties: datatableInputProperties },
  },
  {
    name: "get_carriage",
    description: "Get full details of a single carriage by its ID (UUID or numeric).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Carriage ID" } },
      required: ["id"],
    },
  },
  {
    name: "find_drivers",
    description: `Search drivers in Brunas TMS.\n${DRIVER_FIELDS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        ...datatableInputProperties,
        searchDriver: { type: "string", description: "Text query alias mapped to quickFilter." },
      },
    },
  },
  {
    name: "get_driver",
    description: "Get full details of a single driver by ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Driver ID" } },
      required: ["id"],
    },
  },
  {
    name: "create_driver",
    description: "Create a new driver in Brunas TMS.",
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
    description: "Update an existing driver by ID with fetch-merge semantics.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Driver ID" },
        updates: { type: "object", properties: driverFormFieldProperties, additionalProperties: true },
      },
      required: ["id", "updates"],
    },
  },
  {
    name: "find_vehicles",
    description: `Search vehicles/trucks in Brunas TMS.\n${VEHICLE_FIELDS_DOC}`,
    inputSchema: { type: "object", properties: datatableInputProperties },
  },
  {
    name: "get_vehicle",
    description: "Get full vehicle form data by ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Vehicle ID" } },
      required: ["id"],
    },
  },
  {
    name: "search_vehicles",
    description: "Search active vehicles by plate number or name query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query (e.g. 'NBO401')" } },
      required: ["query"],
    },
  },
  {
    name: "get_vehicle_by_id",
    description: "Get a single vehicle/truck by numeric ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Vehicle ID" } },
      required: ["id"],
    },
  },
  {
    name: "search_vehicle_models",
    description: "Search vehicle makes/models by name query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query (e.g. 'mercedes')" } },
      required: ["query"],
    },
  },
  {
    name: "create_vehicle",
    description: `Create a new vehicle/truck. type: 0=VehicleCarrier, 1=Freezer, 2=Tent, 3=Car, 4=Container, 5=Other, 6=SimpleTruck, 7=Cistern. Ask user for type if not provided.`,
    inputSchema: {
      type: "object",
      properties: {
        vehicleNumber: { type: "string", description: "Vehicle plate number" },
        vehicleModel: { type: "string", description: "Model name string" },
        type: { type: "number", description: "Vehicle type (see description)" },
        makeDate: { type: "string", description: "Manufacturing date (YYYY-MM-DD)" },
        registrationDate: { type: "string", description: "Registration date (YYYY-MM-DD)" },
        vin: { type: "string", description: "VIN code" },
        status: { type: "number", description: "Status: 0=Active (default)" },
      },
      required: ["vehicleNumber", "vehicleModel", "type"],
    },
  },
  {
    name: "update_vehicle",
    description: `Update an existing vehicle by ID with fetch-merge. type: 0=VehicleCarrier..7=Cistern. status: 0=Active..9=Deleted.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Vehicle ID" },
        number: { type: "string", description: "Plate number" },
        vehicleModel: { type: "string", description: "Model name" },
        type: { type: "number", description: "Vehicle type" },
        status: { type: "number", description: "Status" },
        vin: { type: "string", description: "VIN code" },
        makeDate: { type: "string", description: "Manufacturing date (YYYY-MM-DD)" },
      },
      required: ["id"],
    },
  },
  {
    name: "cadency_search",
    description: `Search driver-vehicle cadencies (timeline assignments).\n${CADENCY_FIELDS_DOC}`,
    inputSchema: {
      type: "object",
      properties: {
        ...datatableInputProperties,
        vehicleId: { type: "number", description: "Vehicle ID shortcut" },
        vehicleNumber: { type: "string", description: "Vehicle plate number shortcut" },
        driverId: { type: "number", description: "Driver ID shortcut" },
        driverName: { type: "string", description: "Driver name quick search" },
        status: { type: "string", description: "Single status: planning, current, or ended" },
        statuses: { type: "array", items: { type: "string" }, description: "Multiple statuses" },
        dateFrom: { type: "string", description: "Start date >= filter (YYYY-MM-DD)" },
        dateTo: { type: "string", description: "End date <= filter (YYYY-MM-DD)" },
      },
    },
  },
  {
    name: "create_cadency",
    description: "Create a new driver-vehicle cadency (timeline assignment).",
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
    description: "Update an existing cadency by ID with fetch-merge semantics.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Cadency ID" },
        updates: { type: "object", properties: cadencyFormFieldProperties, additionalProperties: true },
      },
      required: ["id", "updates"],
    },
  },
  {
    name: "find_trailers",
    description: `Search trailers in Brunas TMS. Filter fields: number (isAnyOfContains), trailerType (isAnyOf: 0=Autovežis..5=Cisterna), model, type, vehicleTrailer, vin.`,
    inputSchema: {
      type: "object",
      properties: {
        filters: { type: "array", items: filterItemSchema, description: "Filter items" },
        page: { type: "number", description: "Page (0-based)" },
        pageSize: { type: "number", description: "Results per page" },
        sort: { type: "array", items: sortItemSchema, description: "Sort order" },
      },
    },
  },
  {
    name: "get_trailer",
    description: "Get a single trailer by ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Trailer ID" } },
      required: ["id"],
    },
  },
  {
    name: "create_trailer",
    description: `Create a new trailer. trailerType: 0=Autovežis, 1=Šaldytuvas, 2=Tentas, 3=Konteineris, 4=Kita, 5=Cisterna. model/type: objects from search_superstructure_makes/models.`,
    inputSchema: {
      type: "object",
      properties: {
        trailerType: { type: "number", description: "Trailer type" },
        model: { type: "object", description: "Make { id, model }", properties: { id: { type: "number" }, model: { type: "string" } }, required: ["id", "model"] },
        type: { type: "object", description: "Type { id, type }", properties: { id: { type: "number" }, type: { type: "string" } }, required: ["id", "type"] },
        number: { type: "string", description: "Trailer plate number" },
        vin: { type: "string", description: "VIN code" },
        makeDate: { type: "string", description: "Manufacturing date (YYYY-MM-DD)" },
        dyselis: { type: "boolean", description: "Has diesel heater" },
      },
      required: ["model", "type", "number"],
    },
  },
  {
    name: "update_trailer",
    description: "Update an existing trailer by ID with fetch-merge.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Trailer ID" },
        trailerType: { type: "number" },
        model: { type: "object", properties: { id: { type: "number" }, model: { type: "string" } } },
        type: { type: "object", properties: { id: { type: "number" }, type: { type: "string" } } },
        number: { type: "string" },
        vin: { type: "string" },
        makeDate: { type: "string" },
        dyselis: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "hook_trailer_to_vehicle",
    description: "Create a truck-trailer link. Uses precheck for conflicts.",
    inputSchema: {
      type: "object",
      properties: {
        vehicleId: { type: "number", description: "Vehicle ID" },
        trailerId: { type: "number", description: "Trailer ID" },
        dateFrom: { type: "string", description: "Link start date (YYYY-MM-DD)" },
        dateTo: { type: "string", description: "Optional end date (YYYY-MM-DD)" },
      },
      required: ["vehicleId", "trailerId", "dateFrom"],
    },
  },
  {
    name: "edit_vehicle_trailer_link",
    description: "Edit an existing truck-trailer link with fetch-merge and precheck.",
    inputSchema: {
      type: "object",
      properties: {
        vehicleTrailerId: { type: "number", description: "Link ID" },
        vehicleId: { type: "number", description: "Replacement vehicle ID" },
        trailerId: { type: "number", description: "Replacement trailer ID" },
        dateFrom: { type: "string", description: "Replacement start date" },
        dateTo: { type: "string", description: "Replacement end date or null" },
      },
      required: ["vehicleTrailerId"],
    },
  },
  {
    name: "finish_vehicle_trailer_link",
    description: "Finish an active truck-trailer link by setting end date.",
    inputSchema: {
      type: "object",
      properties: {
        vehicleTrailerId: { type: "number", description: "Link ID" },
        dateTo: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["vehicleTrailerId", "dateTo"],
    },
  },
  {
    name: "delete_vehicle_trailer_link",
    description: "Delete a truck-trailer link.",
    inputSchema: {
      type: "object",
      properties: {
        vehicleTrailerId: { type: "number", description: "Link ID" },
      },
      required: ["vehicleTrailerId"],
    },
  },
  {
    name: "search_superstructure_makes",
    description: "Search trailer/superstructure makes by name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "create_superstructure_make",
    description: "Create a new trailer/superstructure make.",
    inputSchema: {
      type: "object",
      properties: { make: { type: "string", description: "Make name" } },
      required: ["make"],
    },
  },
  {
    name: "search_superstructure_models",
    description: "Search trailer/superstructure models (types) by name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "create_superstructure_model",
    description: "Create a new trailer/superstructure model (type).",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string", description: "Model/type name" } },
      required: ["type"],
    },
  },
  {
    name: "search_damages",
    description: `Search vehicle damages/failures. Filter fields: status (isAnyOf: pending, seen, inProgress, completed, cancelled), transport (isAnyOf: "vehicle-{id}"), category, urgency, description (contains), creatorName, createDate (range).`,
    inputSchema: {
      type: "object",
      properties: {
        ...datatableInputProperties,
        vehicleNumber: { type: "string", description: "Vehicle plate shortcut (auto-resolves to ID)" },
      },
    },
  },
  {
    name: "register_damage",
    description: "Register a vehicle damage/failure. Urgency: tolerable, urgent, critical. Category: body-work, engine, transmission, electrical, brakes, suspension, tires, other.",
    inputSchema: {
      type: "object",
      properties: {
        vehicleId: { type: "number", description: "Vehicle ID" },
        description: { type: "string", description: "Damage description" },
        urgency: { type: "string", description: "Urgency level (default: tolerable)" },
        category: { type: "string", description: "Category (default: body-work)" },
        trailerId: { type: "number", description: "Trailer ID if damage is on trailer" },
      },
      required: ["vehicleId", "description"],
    },
  },
  {
    name: "update_damage",
    description: "Update an existing damage record (e.g. to change status or attach photos).",
    inputSchema: {
      type: "object",
      properties: {
        damageId: { type: "string", description: "Damage UUID" },
        data: { type: "object", description: "Partial damage payload" },
      },
      required: ["damageId", "data"],
    },
  },
];

// ─── Admin tool definitions ──────────────────────────────────────────

export const ADMIN_TOOL_DEFS: ToolDef[] = [
  {
    name: "select_client",
    description: "Switch to a different Brunas client company. Only available to super-admin users. Pass exact client name or domain.",
    inputSchema: {
      type: "object",
      properties: {
        clientId: { type: "string", description: "Exact client name or domain" },
      },
      required: ["clientId"],
    },
  },
];

// ─── BSS Accounting tool definitions ─────────────────────────────────

export const BSS_TOOL_DEFS: ToolDef[] = [
  {
    name: "set_bss_password",
    description: "Set the BSS API password for this session. Must be called once before any invoice query. Password is stored in memory only.",
    inputSchema: {
      type: "object",
      properties: {
        password: { type: "string", description: "The BSS API password" },
      },
      required: ["password"],
    },
  },
  {
    name: "check_invoice_status",
    description: "Check payment status of invoices in BSS accounting. Returns payment status, totals, VAT, unpaid balance.",
    inputSchema: {
      type: "object",
      properties: {
        invoice_numbers: {
          type: "array",
          items: { type: "string" },
          description: 'Invoice numbers, e.g. ["INV-001"]',
        },
      },
      required: ["invoice_numbers"],
    },
  },
];

// ─── Conversion helper ───────────────────────────────────────────────

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toOpenAITools(defs: ToolDef[]): OpenAITool[] {
  return defs.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}
