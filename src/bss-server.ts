#!/usr/bin/env node

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import https from "node:https";

// BSS ERP uses a certificate that Node.js cannot verify
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Error helpers ───────────────────────────────────────────────────

class McpError extends Error {
  constructor(
    public code: string,
    message: string,
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

// ─── Credential store (session-only, never persisted to disk) ────────

let bssPassword: string | null = null;

const BSS_USER = "API_DELTRA";
const BSS_ENV = "Deltra UAB";
const BSS_URL =
  "https://erp.bss.biz/ERPIntegrationServiceHost/BSSIT/v2/service/ErpEInvoiceIntegrationService";

// ─── SOAP helpers ────────────────────────────────────────────────────

function buildGetInvoiceStatusXml(invoiceNumber: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<GetInvoiceStatus xmlns="http://erp.bss.biz/">
<request>
<User>${BSS_USER}</User>
<Password>${bssPassword}</Password>
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

interface InvoiceStatusResult {
  invoiceNumber: string;
  success: boolean;
  invoiceStatus?: string;
  paymentStatus?: string;
  totalPrice?: string;
  totalVAT?: string;
  totalPriceWithVAT?: string;
  unpaidBalance?: string;
  statusChangedDate?: string;
  error?: string;
}

async function fetchInvoiceStatus(
  invoiceNumber: string,
): Promise<InvoiceStatusResult> {
  const body = buildGetInvoiceStatusXml(invoiceNumber);

  try {
    const resp = await axios.post(BSS_URL, body, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "http://erp.bss.biz/IErpEInvoiceIntegrationService/GetInvoiceStatus",
        Accept: "*/*",
      },
      timeout: 30_000,
      validateStatus: () => true,
      httpsAgent,
    });

    const xml: string = resp.data;

    if (resp.status >= 400) {
      const fault = extractTag(xml, "faultstring") ?? extractTag(xml, "Text") ?? xml.slice(0, 500);
      return { invoiceNumber, success: false, error: `HTTP ${resp.status}: ${fault}` };
    }

    const success = extractTag(xml, "Success");
    if (success?.toLowerCase() !== "true") {
      return {
        invoiceNumber,
        success: false,
        error: extractTag(xml, "Message") ?? "BSS returned Success=false",
      };
    }

    return {
      invoiceNumber,
      success: true,
      invoiceStatus: extractTag(xml, "InvoiceStatus") ?? undefined,
      paymentStatus: extractTag(xml, "InvoicePaymentStatus") ?? undefined,
      totalPrice: extractTag(xml, "InvoiceTotalPrice") ?? undefined,
      totalVAT: extractTag(xml, "InvoiceTotalVAT") ?? undefined,
      totalPriceWithVAT: extractTag(xml, "InvoiceTotalPriceWithVAT") ?? undefined,
      unpaidBalance: extractTag(xml, "InvoiceUnpaidBalance") ?? undefined,
      statusChangedDate: extractTag(xml, "InvoiceStatusChangedDate") ?? undefined,
    };
  } catch (err: unknown) {
    let msg = err instanceof Error ? err.message : String(err);
    // Axios may attach response data even on thrown errors
    const axiosErr = err as { response?: { data?: string; status?: number } };
    if (axiosErr.response?.data) {
      const respXml = String(axiosErr.response.data);
      const fault = extractTag(respXml, "faultstring") ?? extractTag(respXml, "Text") ?? respXml.slice(0, 500);
      msg = `HTTP ${axiosErr.response.status}: ${fault}`;
    }
    return { invoiceNumber, success: false, error: msg };
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────

const server = new Server(
  { name: "bss-accounting", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ── List tools ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "set_bss_password",
      description:
        "Set the BSS API password for this session. Must be called once before any BSS query. The password is stored in memory only and discarded when the server stops. Ask the user for the password if not provided.",
      inputSchema: {
        type: "object" as const,
        properties: {
          password: {
            type: "string",
            description: "The BSS API password.",
          },
        },
        required: ["password"],
      },
    },
    {
      name: "check_invoice_status",
      description:
        "Check the payment status of one or more invoices in the BSS accounting system. Returns payment status (Paid / Unpaid), invoice status, totals, and unpaid balance for each invoice. If the BSS password has not been set yet, the agent should first call set_bss_password.",
      inputSchema: {
        type: "object" as const,
        properties: {
          invoice_numbers: {
            type: "array",
            items: { type: "string" },
            description:
              'One or more invoice numbers to check, e.g. ["INV-001", "INV-002"].',
          },
        },
        required: ["invoice_numbers"],
      },
    },
  ],
}));

// ── Call tools ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── set_bss_password ──────────────────────────────────────────────
  if (name === "set_bss_password") {
    const pw = (args as { password?: string }).password;
    if (!pw) {
      throw new McpError(ErrorCode.InvalidRequest, "password is required");
    }
    bssPassword = pw;
    return {
      content: [{ type: "text", text: "BSS password set for this session." }],
    };
  }

  // ── check_invoice_status ──────────────────────────────────────────
  if (name === "check_invoice_status") {
    if (!bssPassword) {
      return {
        content: [
          {
            type: "text",
            text: "BSS password is not set. Please call set_bss_password first.",
          },
        ],
      };
    }

    const rawNumbers = (args as { invoice_numbers?: string[] })
      .invoice_numbers;
    if (!rawNumbers || rawNumbers.length === 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "invoice_numbers array is required and must not be empty",
      );
    }

    // Auto-insert "-" between letter prefix and digits: DEL0005629 → DEL-0005629
    const invoiceNumbers = rawNumbers.map((n) =>
      n.replace(/^([A-Za-z]+)(\d)/, "$1-$2"),
    );

    const results = await Promise.all(
      invoiceNumbers.map((num) => fetchInvoiceStatus(num)),
    );

    const lines = results.map((r) => {
      if (!r.success) {
        return `Invoice ${r.invoiceNumber}: ERROR — ${r.error}`;
      }
      return [
        `Invoice ${r.invoiceNumber}:`,
        `  Payment: ${r.paymentStatus}`,
        `  Status: ${r.invoiceStatus}`,
        `  Total: ${r.totalPriceWithVAT} EUR (VAT ${r.totalVAT})`,
        `  Unpaid balance: ${r.unpaidBalance} EUR`,
        `  Status changed: ${r.statusChangedDate}`,
      ].join("\n");
    });

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
    };
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

// ─── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BSS Accounting MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
