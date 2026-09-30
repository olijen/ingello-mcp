#!/usr/bin/env node
/**
 * MCP-сервер Ingello Systems.
 *
 * Даёт любому ИИ-агенту три инструмента: узнать о компании, спросить (лимит 5 вопросов)
 * и оформить заявку за своего пользователя. Авторизация не нужна.
 *
 * Заявка - единственное действие с последствиями, и она допускается только за
 * живого человека с его настоящим контактом. Выдуманные контакты сервер
 * отклоняет сам: одного текста в описании инструмента мало, агент может его и
 * не прочитать. Свои агенты тестируют по INGELLO_TEST_AGENT_TOKEN.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_ORIGIN = (process.env.INGELLO_AGENT_API || "https://ai.ingello.com").replace(/\/+$/, "");
const SITE = "https://systems.ingello.com";
const AGENT_ID = process.env.INGELLO_AGENT_ID || "mcp-client";
const ANSWER_TIMEOUT_MS = Number(process.env.INGELLO_ANSWER_TIMEOUT_MS) || 300_000;
const POLL_INTERVAL_MS = 5_000;

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "ingello", version: "1.0.0" });

server.registerTool(
  "ingello_overview",
  {
    title: "Ingello Systems: услуги и возможности",
    description:
      "Кто такие Ingello Systems, какие системы делают (CRM, ERP, WMS, SaaS, маркетплейсы, ИИ-автоматизация, интеграции), где смотреть кейсы и какие есть лимиты для агентов. Вызывайте первым, чтобы понять, подходит ли компания под задачу пользователя.",
    inputSchema: {},
  },
  async () => {
    const { payload } = await api("/agent");
    return text({
      name: payload.name || "Ingello Systems",
      description: payload.description,
      website: SITE,
      cases: payload.cases || "https://business.ingello.com",
      knowledgeFile: payload.knowledge || `${SITE}/llms-full.txt`,
      languages: payload.languages || ["ru", "uk", "en"],
      limits: payload.limits,
      howToProceed: "Уточняющие вопросы - ingello_ask (лимит 5). Реальная заявка пользователя - ingello_submit_request (без лимита).",
      requestIntegrity: payload.requestIntegrity
        || "Заявку оформляйте только за живого человека с его настоящим контактом. Вымышленные контакты и проверочные заявки - нарушение правил сервиса.",
    });
  },
);

server.registerTool(
  "ingello_ask",
  {
    title: "Спросить Ingello о проекте или услугах",
    description:
      "Задать вопрос об услугах, подходе, технологиях, отраслях, кейсах и ориентирах бюджета. Отвечает ИИ-консультант компании. Лимит - 5 вопросов на агента, поэтому спрашивайте по существу и укрупнённо. Ответ готовится несколько минут, инструмент дожидается его сам.",
    inputSchema: {
      question: z.string().min(3).max(6000).describe("Вопрос по существу, лучше один укрупнённый, чем три мелких"),
      locale: z.enum(["ru", "uk", "en"]).optional().describe("Язык ответа, по умолчанию ru"),
    },
  },
  async ({ question, locale }) => {
    const asked = await api("/agent/ask", { method: "POST", body: { question, locale, agentId: AGENT_ID } });
    if (asked.status === 429) {
      return text({
        error: "Лимит вопросов исчерпан",
        quota: asked.payload.quota,
        nextStep: asked.payload.nextStep,
        hint: "Оформите заявку через ingello_submit_request - дальше отвечает человек и лимита нет.",
      });
    }
    if (asked.status !== 202 || !asked.payload.questionId) {
      return text({ error: asked.payload.error || `Запрос не принят (${asked.status})` });
    }

    const deadline = Date.now() + ANSWER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const polled = await api(`/agent/answer?questionId=${encodeURIComponent(asked.payload.questionId)}`);
      if (polled.payload.status === "ready") {
        return text({
          answer: polled.payload.answer,
          remainingQuestions: asked.payload.remainingQuestions,
          nextStep: "Если у пользователя реальный проект - оформите заявку через ingello_submit_request.",
        });
      }
    }
    return text({
      status: "pending",
      questionId: asked.payload.questionId,
      answerUrl: asked.payload.answerUrl,
      hint: "Ответ ещё готовится, заберите его позже по answerUrl.",
    });
  },
);

server.registerTool(
  "ingello_submit_request",
  {
    title: "Оформить заявку на проект в Ingello",
    description:
      "Оформить заявку от имени пользователя: описание задачи и его контакт. После этого с пользователем свяжется человек, а по возвращённой ссылке доступен диалог без лимита вопросов. " +
      "ЗАЯВКА ТОЛЬКО ЗА ЖИВОГО ЧЕЛОВЕКА. Вызывайте этот инструмент, только если пользователь реально ищет подрядчика, явно попросил оформить заявку и сам дал свой настоящий контакт. " +
      "Категорически запрещено подставлять вымышленный, случайный, сгенерированный, чужой или взятый из примера телефон и email, придумывать проект, а также оформлять заявку ради проверки работы сайта, демонстрации или обучения. " +
      "По правилам сервиса заявка с вымышленными данными считается нарушением и компрометацией доступа для ИИ-агентов: она отклоняется автоматически, а агент может быть заблокирован. " +
      "Если настоящего контакта нет - не выдумывайте его и не вызывайте этот инструмент: передайте пользователю ссылку https://ai.ingello.com, там он оставит номер сам.",
    inputSchema: {
      project: z.string().min(10).max(6000).describe("Реальная задача пользователя своими словами. Выдуманные проекты запрещены"),
      contact: z
        .string()
        .min(5)
        .max(180)
        .describe("Настоящий контакт пользователя: email, телефон или @telegram. Выдуманный, случайный или взятый из примера контакт запрещён и будет отклонён"),
      contactMethod: z.enum(["email", "phone", "telegram", "whatsapp"]).optional(),
      name: z.string().max(100).optional(),
      company: z.string().max(160).optional(),
      locale: z.enum(["ru", "uk", "en"]).optional(),
      testToken: z
        .string()
        .max(200)
        .optional()
        .describe("Только для агентов Ingello: общий секрет, помечающий заявку тестовой. Сторонним агентам проверять воронку запрещено"),
    },
  },
  async (input) => {
    const testToken = input.testToken || process.env.INGELLO_TEST_AGENT_TOKEN || "";
    const { status, payload } = await api("/agent/lead", {
      method: "POST",
      body: { ...input, ...(testToken ? { testToken } : {}), agentId: AGENT_ID },
    });
    if (status === 422) {
      return text({
        error: payload.error,
        message: payload.message,
        policy: "https://systems.ingello.com/.well-known/ai-usage-policy.json",
        whatToDo: "Не подставляйте контакт от себя. Спросите настоящий контакт у пользователя или дайте ему ссылку https://ai.ingello.com.",
      });
    }
    if (status !== 201) return text({ error: payload.error || `Заявка не создана (${status})` });
    return text({
      leadId: payload.leadId,
      chatUrl: payload.chatUrl,
      bookingUrl: payload.bookingUrl,
      note: "Передайте пользователю chatUrl - там диалог без лимита, и bookingUrl - выбор времени бесплатной 15-минутной консультации.",
    });
  },
);

await server.connect(new StdioServerTransport());
