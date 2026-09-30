import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");

/** Поднимает заглушку публичного API Ingello, чтобы не ходить в прод из тестов. */
async function startApiStub(context, handlers) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ url: request.url, method: request.method, body: body ? JSON.parse(body) : null });
      const handler = handlers[`${request.method} ${request.url.split("?")[0]}`];
      const result = handler ? handler(calls) : { status: 404, payload: { ok: false, error: "not_found" } };
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

async function connect(context, origin) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, INGELLO_AGENT_API: origin, INGELLO_AGENT_ID: "test-agent", INGELLO_ANSWER_TIMEOUT_MS: "20000" },
  });
  await client.connect(transport);
  context.after(() => client.close());
  return client;
}

test("mcp server exposes three self-describing tools", async (context) => {
  const { origin } = await startApiStub(context, {});
  const client = await connect(context, origin);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ingello_ask", "ingello_overview", "ingello_submit_request"]);
  const ask = tools.find((tool) => tool.name === "ingello_ask");
  assert.match(ask.description, /5 вопросов/, "лимит виден агенту прямо в описании инструмента");
  const submit = tools.find((tool) => tool.name === "ingello_submit_request");
  assert.deepEqual(submit.inputSchema.required.sort(), ["contact", "project"]);
});

test("ingello_ask waits for the async answer and reports the remaining quota", async (context) => {
  let polls = 0;
  const { origin, calls } = await startApiStub(context, {
    "POST /agent/ask": () => ({ status: 202, payload: { ok: true, questionId: "1788000000000-abcdef12", remainingQuestions: 4 } }),
    "GET /agent/answer": () => {
      polls += 1;
      return polls < 2
        ? { status: 200, payload: { ok: true, status: "pending" } }
        : { status: 200, payload: { ok: true, status: "ready", answer: "Делаем CRM, ERP и WMS на заказ." } };
    },
  });
  const client = await connect(context, origin);

  const result = await client.callTool({ name: "ingello_ask", arguments: { question: "Какие системы вы разрабатываете?" } });
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.answer, /CRM/);
  assert.equal(payload.remainingQuestions, 4);
  assert.equal(calls[0].body.agentId, "test-agent", "агент представляется, чтобы лимит считался по нему");
});

test("exhausted quota is answered with the next step, not with a dead end", async (context) => {
  const { origin } = await startApiStub(context, {
    "POST /agent/ask": () => ({
      status: 429,
      payload: { ok: false, error: "question_quota_exhausted", quota: 5, nextStep: { action: "submit_request", url: "https://ai.ingello.com/agent/lead" } },
    }),
  });
  const client = await connect(context, origin);

  const result = await client.callTool({ name: "ingello_ask", arguments: { question: "Шестой вопрос" } });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.nextStep.action, "submit_request");
  assert.match(payload.hint, /submit_request/);
});

test("ingello_submit_request returns the human handoff links", async (context) => {
  const { origin, calls } = await startApiStub(context, {
    "POST /agent/lead": () => ({
      status: 201,
      payload: { ok: true, leadId: "FL-1", chatUrl: "https://ai.ingello.com/adopt?code=x", bookingUrl: "https://systems.ingello.com/calendar/?token=y" },
    }),
  });
  const client = await connect(context, origin);

  const result = await client.callTool({
    name: "ingello_submit_request",
    arguments: { project: "Нужна CRM для сети клиник", contact: "client@example.com", name: "Олена" },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.leadId, "FL-1");
  assert.match(payload.chatUrl, /adopt/);
  assert.equal(calls[0].body.project, "Нужна CRM для сети клиник");
});
