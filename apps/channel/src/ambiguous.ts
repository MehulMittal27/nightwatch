/**
 * Minimal Ambiguous MCP client - the WRITE side of the workspace.
 *
 * The agent is deliberately NOT given these tools. `makeChannelAgent` runs with
 * workplace MCP disabled, so the model cannot create, edit, share or delete a
 * document on its own. Every write to the workspace goes through this file, and
 * this file is only ever called from behind an approval gate.
 *
 * That is the same argument the project makes about the telescope: an approval
 * card guides behaviour, it does not enforce anything. The enforcement lives at
 * the write boundary, and the write boundary is here.
 */

const MCP_URL = "https://app.ambiguous.ai/mcp";

interface McpCall {
  name: string;
  args: Record<string, unknown>;
}

function apiKey(): string {
  const key = process.env.AMBIGUOUS_API_KEY;
  if (!key) throw new Error("AMBIGUOUS_API_KEY is not set");
  return key;
}

/** Parse the server-sent-event framing the MCP endpoint replies with. */
function parseSse(body: string): unknown {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length === 0) continue;
    return JSON.parse(payload) as unknown;
  }
  throw new Error(`MCP returned no data frame: ${body.slice(0, 200)}`);
}

async function rpc(method: string, params: unknown, sessionId?: string): Promise<Response> {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
}

/** Initialise a session and call one tool. Short-lived on purpose. */
async function callTool(call: McpCall): Promise<unknown> {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nightwatch", version: "1" },
  });
  if (!init.ok) throw new Error(`Ambiguous MCP initialize failed: HTTP ${init.status}`);
  const sessionId = init.headers.get("mcp-session-id") ?? undefined;
  await init.text();

  const res = await rpc("tools/call", { name: call.name, arguments: call.args }, sessionId);
  if (!res.ok) throw new Error(`Ambiguous ${call.name} failed: HTTP ${res.status}`);

  const parsed = parseSse(await res.text()) as { error?: { message?: string }; result?: unknown };
  if (parsed.error) throw new Error(`Ambiguous ${call.name} failed: ${parsed.error.message}`);
  return parsed.result;
}

export interface CreatedDocument {
  id: string;
  title: string;
}

/**
 * Create the follow-up circular as a workspace document.
 *
 * Callers MUST have re-checked consent immediately before calling this. There
 * is no approval logic in here by design - a gate that lives inside the thing
 * it guards is not a gate.
 */
export async function createCircularDocument(
  title: string,
  body: string,
): Promise<CreatedDocument> {
  const result = (await callTool({
    name: "create_document",
    args: { title, type: "document", content: body },
  })) as { content?: { type: string; text?: string }[] };

  // MCP tool results come back as content blocks; the document id is inside the
  // JSON payload the server returns as text.
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  let id = "unknown";
  try {
    const doc = JSON.parse(text) as { id?: string; document?: { id?: string } };
    id = doc.id ?? doc.document?.id ?? "unknown";
  } catch {
    // Leave id as unknown rather than inventing one.
  }
  return { id, title };
}

/** Read-only identity check, used to prove the workspace link without writing. */
export async function whoami(): Promise<unknown> {
  return callTool({ name: "auth_whoami", args: {} });
}
