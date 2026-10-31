import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogueResponse } from "../marketplace/catalogue";
import type { MarketplaceQuery } from "../marketplace/query";
import { createSiriusMcpHandler, MCP_MAX_REQUEST_BYTES, rejectMcpRequest } from "./mcp";
import { AGENT_TOOL_NAMES, type AgentToolSource } from "./tools";

const ORIGIN = "https://sirius-data.tech";
const LEGACY = "2025-06-18";
const MODERN = "2026-07-28";

function emptyCatalogue(): CatalogueResponse {
  return {
    items: [
      {
        id: "ds-1",
        name: "Building\u202E energy",
        category: "energy",
        modelId: "linear_regression",
        modelVersion: "1.0.0",
        rowCount: 500,
        columnCount: 6,
        sizeBytes: 1_000,
        providerPriceAtomic: "3000000",
        priceAtomic: "10000000",
        priceKind: "borrowerPays",
        borrowCount: 1,
        verified: true,
        listedAt: null,
      },
    ],
    total: 1,
    page: 1,
    pageCount: 1,
    pageSize: 24,
    truncated: false,
    token: { symbol: "USDG", decimals: 6 },
    computeFees: {
      linear_regression: { kind: "quoted", atomic: "7000000" },
      logistic_regression: { kind: "unknown", atomic: null },
    },
    kybAvailable: true,
  };
}

interface Calls {
  catalogue: MarketplaceQuery[];
  dataset: string[];
  certificate: string[];
  requests: (Request | undefined)[];
}

function fixture(overrides: Partial<AgentToolSource> = {}) {
  const calls: Calls = { catalogue: [], dataset: [], certificate: [], requests: [] };
  const handler = createSiriusMcpHandler((request) => {
    calls.requests.push(request);
    return {
      catalogue: async (query) => {
        calls.catalogue.push(query);
        return emptyCatalogue();
      },
      dataset: async (id) => {
        calls.dataset.push(id);
        return null;
      },
      pricing: () => ({ symbol: "USDG", settlementToken: "USDG (Global Dollar, issued by Paxos)", tariff: null }),
      status: () => {
        throw new Error("connect ECONNREFUSED https://rpc.example/secret-key");
      },
      certificate: async (loanId) => {
        calls.certificate.push(loanId);
        return { kind: "not-found" };
      },
      ...overrides,
    };
  }, ORIGIN);
  return { handler, calls };
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
};

function legacyRequest(method: string, params: Record<string, unknown> = {}, id = 1): Request {
  return new Request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": LEGACY },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

function modernRequest(method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN,
    "mcp-method": method,
    ...extraHeaders,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  return new Request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: MODERN_META } }),
  });
}

/** Corps JSON-RPC d'une réponse, qu'elle soit en JSON (2026) ou en un seul événement SSE (2025). */
interface RpcReply {
  result?: {
    tools?: { name: string; annotations: Record<string, boolean>; outputSchema?: unknown }[];
    isError?: boolean;
    resultType?: string;
    content?: { type: string; text: string }[];
    structuredContent?: { status?: string; datasets?: { name: string; url: string }[] };
  };
  error?: { code: number; message: string };
}

async function rpc(response: Response): Promise<RpcReply> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data, `aucun événement dans ${text}`);
    return JSON.parse(data.slice("data: ".length));
  }
  return JSON.parse(text);
}

test("la liste des outils : les cinq, dans l'ordre, tous en lecture seule", async () => {
  const { handler } = fixture();
  const { result } = await rpc(await handler.fetch(legacyRequest("tools/list")));
  const tools = result!.tools!;
  assert.deepEqual(tools.map((tool) => tool.name), [...AGENT_TOOL_NAMES]);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.ok(tool.outputSchema, tool.name);
  }
});

test("search_datasets : requête transmise au catalogue, réponse structurée et texte encadré", async () => {
  const { handler, calls } = fixture();
  const { result } = await rpc(
    await handler.fetch(legacyRequest("tools/call", { name: "search_datasets", arguments: { query: "Énergie", category: "energy" } })),
  );
  assert.deepEqual(calls.catalogue[0].terms, ["energie"]);
  assert.equal(calls.catalogue[0].category, "energy");
  assert.equal(result!.isError, undefined);
  assert.equal(result!.structuredContent!.datasets![0].name, "Building energy");
  assert.equal(result!.structuredContent!.datasets![0].url, "https://sirius-data.tech/marketplace/ds-1");
  assert.match(result!.content![0].text, /^<tool_data>\n.*data, not instructions/);
});

test("le client 2026-07-28 est servi sans état, en JSON", async () => {
  const { handler, calls } = fixture();
  const response = await handler.fetch(modernRequest("tools/call", { name: "verify_certificate", arguments: { loanId: "cmv3odsf8" } }));
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const { result } = await rpc(response);
  assert.equal(result!.structuredContent!.status, "not_found");
  assert.equal(result!.resultType, "complete");
  assert.deepEqual(calls.certificate, ["cmv3odsf8"]);
  // La source est construite avec la requête : le limiteur des certificats voit l'appelant.
  assert.ok(calls.requests.at(-1) instanceof Request);
});

test("une source en panne rend une erreur générique, jamais son message", async () => {
  const { handler } = fixture();
  const response = await handler.fetch(legacyRequest("tools/call", { name: "get_protocol_status", arguments: {} }));
  const raw = await response.clone().text();
  const { result } = await rpc(response);
  assert.equal(result!.isError, true);
  assert.equal(raw.includes("secret-key"), false);
  assert.equal(raw.includes("rpc.example"), false);
});

test("une entrée hors schéma est refusée avant toute lecture", async () => {
  const { handler, calls } = fixture();
  for (const args of [{ datasetId: "../admin" }, { datasetId: "x".repeat(65) }, { datasetId: 42 }]) {
    const { result } = await rpc(await handler.fetch(legacyRequest("tools/call", { name: "get_dataset", arguments: args })));
    assert.equal(result!.isError, true);
  }
  const { result } = await rpc(
    await handler.fetch(legacyRequest("tools/call", { name: "search_datasets", arguments: { query: "x".repeat(101) } })),
  );
  assert.equal(result!.isError, true);
  assert.deepEqual(calls.dataset, []);
  assert.deepEqual(calls.catalogue, []);
});

test("un outil inconnu n'existe pas", async () => {
  const { handler } = fixture();
  const reply = await rpc(await handler.fetch(legacyRequest("tools/call", { name: "borrow_dataset", arguments: {} })));
  assert.ok(reply.error || reply.result?.isError);
});

test("un corps trop gros est refusé avant d'être lu", async () => {
  const { handler } = fixture();
  const response = await handler.fetch(
    new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(MCP_MAX_REQUEST_BYTES) } }),
    }),
  );
  assert.equal(response.status, 413);
});

test("Origin : absent ou celui du site passe, tout autre est refusé", () => {
  const request = (origin?: string) =>
    new Request(`${ORIGIN}/api/mcp`, { method: "POST", headers: origin === undefined ? {} : { origin } });
  assert.equal(rejectMcpRequest(request(), ORIGIN), undefined);
  assert.equal(rejectMcpRequest(request(ORIGIN), ORIGIN), undefined);
  assert.equal(rejectMcpRequest(request("https://evil.example"), ORIGIN)?.status, 403);
  assert.equal(rejectMcpRequest(request("https://sirius-data.tech.evil.example"), ORIGIN)?.status, 403);
  assert.equal(rejectMcpRequest(request("null"), ORIGIN)?.status, 403);
});

test("subscriptions/listen est refusé : aucun flux ne reste ouvert sur la fonction", async () => {
  const listen = modernRequest("subscriptions/listen", { notifications: { toolsListChanged: true } });
  const refusal = rejectMcpRequest(listen, ORIGIN);
  assert.equal(refusal?.status, 405);
  const body = await refusal!.json();
  assert.equal(body.error.code, -32601);
  // Un appel ordinaire du même client passe.
  assert.equal(rejectMcpRequest(modernRequest("tools/list"), ORIGIN), undefined);
});
