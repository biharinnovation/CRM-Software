import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import cache from "../../utils/cache.js";
import prisma from "../../utils/prisma.js";
import { ApiError } from "../../utils/apiError.js";
import systemPromptService from "../system-prompt/system-prompt.service.js";
import searchService from "../search/search.service.js";
import dbQueryService from "./dbQuery.service.js";

/**
 * AI Service — unified interface for Gemini, OpenAI, and Custom providers.
 * Uses official SDKs: @google/genai for Gemini, openai for OpenAI.
 * Custom provider uses raw fetch (OpenAI-compatible format).
 */
/** How much of a tool call is kept on the stored trace. */
/**
 * web_search calls one copilot message may make.
 *
 * Deliberately small. A reasoning model treats one hosted web_search as a
 * research task and fans it out internally — a single call was measured issuing
 * six searches, and every one of those is billed. So the real ceiling per
 * message is this number times whatever the model decides to do, not this
 * number.
 */
const WEB_SEARCH_BUDGET = 3;

/** Sources kept per search — enough to cite, not enough to flood the trace. */
const WEB_SEARCH_MAX_SOURCES = 8;

/** Shared between the live web_search tool and its catalog listing. */
const WEB_SEARCH_DESCRIPTION =
  "Search the live web for information that is NOT in the CRM — a prospect's company, industry news, a competitor, a public price list, a person's background. Do NOT use it for anything about your own clients, projects, tasks, invoices or staff; that lives in the database, use query_database. Returns a written answer plus source URLs. Cite the sources you use as markdown links.";

const TRACE_LIMITS = { args: 2000, preview: 1200, error: 500, calls: 40 };

class AiService {
  /** @type {GoogleGenAI|null} */ #geminiClient = null;
  /** @type {OpenAI|null} */      #openaiClient = null;

  // Cache SDK clients so we don't re-instantiate on every call.
  // Invalidated when API key or base URL changes.
  #geminiKey = null;
  #openaiKey = null;
  #openaiBaseUrl = null;

  /**
   * Tool definitions for CRM Copilot.
   * Each tool corresponds to a function the AI can call.
   */
  /** model id → { useMaxCompletionTokens, noTemperature } learned from 400s. */
  #modelQuirks = new Map();

  #tools = [
    // {
    //   name: "global_search",
    //   description: "Search the CRM database for leads, deals, clients, projects, teams, users, and services. BE VERY SPECIFIC with your query for best results. Examples: 'leads', 'recent leads', 'active clients', 'negotiation deals', 'Kunal Bhatia', 'ABC Corp', 'completed projects', 'high priority leads'.",
    //   parameters: {
    //     type: "object",
    //     properties: {
    //       query: {
    //         type: "string",
    //         description: "SPECIFIC search query. Use entity names, statuses, or keywords. E.g., 'leads' (all leads), 'active clients', 'Kunal' (person name), 'ABC Corp' (company name)"
    //       },
    //       limit: {
    //         type: "integer",
    //         description: "Maximum results per category (default: 10, max: 20)",
    //         default: 10
    //       }
    //     },
    //     required: ["query"]
    //   }
    // },
    // {
    //   name: "get_overall_stats",
    //   description: "Get overall statistics/counts for the CRM. Use this when user asks for general stats like 'how many leads', 'total deals', 'active projects count', etc.",
    //   parameters: {
    //     type: "object",
    //     properties: {}
    //   }
    // },
    // {
    //   name: "list_entities",
    //   description: "List records of ONE entity type. Use for 'show my leads', 'all deals', 'list clients', 'projects in progress', 'list invoices', 'my tasks', 'upcoming meetings', etc. Prefer over global_search when the user wants a LIST. IMPORTANT: only use one of the exact entity values below. If the user asks for an entity NOT in this list, use query_database instead — NEVER substitute a different entity.",
    //   parameters: {
    //     type: "object",
    //     properties: {
    //       entity: {
    //         type: "string",
    //         enum: ["leads", "deals", "clients", "projects", "users", "teams", "services", "invoices", "tasks", "meetings", "followups", "jobs", "holidays", "leaverequests", "announcements"],
    //         description: "Which entity type to list. Must be exactly one of these."
    //       },
    //       status: {
    //         type: "string",
    //         description: "Optional status/stage filter. Leads: NEW|CONTACTED|QUALIFIED|UNQUALIFIED|CONVERTED|LOST. Deals stage: DISCOVERY|PROPOSAL|NEGOTIATION|WON|LOST. Clients: ACTIVE|INACTIVE|CHURNED. Projects: DUE_SIGNING|NOT_STARTED|IN_PROGRESS|ON_HOLD|COMPLETED|CANCELLED. Invoices: DRAFT|SENT|PAID|PARTIALLY_PAID|OVERDUE|CANCELLED. Tasks: TODO|IN_PROGRESS|IN_REVIEW|COMPLETED|REVIEWED. Meetings: SCHEDULED|COMPLETED|CANCELLED|NO_SHOW. LeaveRequests: PENDING|APPROVED|REJECTED|CANCELLED. Jobs: DRAFT|OPEN|CLOSED|ARCHIVED."
    //       },
    //       limit: {
    //         type: "integer",
    //         description: "Max records (default 25, max 100).",
    //         default: 25
    //       }
    //     },
    //     required: ["entity"]
    //   }
    // },
    // {
    //   name: "get_lead_details",
    //   description: "Get detailed information about a specific lead by ID. Use this when user wants to see full details of a lead.",
    //   parameters: {
    //     type: "object",
    //     properties: {
    //       id: {
    //         type: "string",
    //         description: "The lead ID"
    //       }
    //     },
    //     required: ["id"]
    //   }
    // },
    // {
    //   name: "get_deal_details",
    //   description: "Get detailed information about a specific deal by ID. Use this when user wants to see full details of a deal including value and stage.",
    //   parameters: {
    //     type: "object",
    //     properties: {
    //       id: {
    //         type: "string",
    //         description: "The deal ID"
    //       }
    //     },
    //     required: ["id"]
    //   }
    // },
    // {
    //   name: "get_client_details",
    //   description: "Get detailed information about a specific client by ID. Use this when user wants to see full details of a client.",
    //   parameters: {
    //     type: "object",
    //     properties: {
    //       id: {
    //         type: "string",
    //         description: "The client ID"
    //       }
    //     },
    //     required: ["id"]
    //   }
    // },
    // {
    //   name: "get_project_details",
    //   description: "Get detailed information about a specific project by ID. Use this when user wants to see full details of a project.",
    //   parameters: {
    //     type: "object",
    //     properties: {
    //       id: {
    //         type: "string",
    //         description: "The project ID"
    //       }
    //     },
    //     required: ["id"]
    //   }
    // },
    // {
    //   name: "list_project_tasks",
    //   description: "List all tasks for a specific project by project ID. Use this when the user asks about tasks, to-dos, or work items in a project. If you only have the project name, first call global_search or list_entities to find its ID.",
    //   parameters: {
    //     type: "object",
    //     properties: {
    //       projectId: {
    //         type: "string",
    //         description: "The project ID (cuid)."
    //       },
    //       status: {
    //         type: "string",
    //         enum: ["TODO", "IN_PROGRESS", "IN_REVIEW", "COMPLETED", "REVIEWED"],
    //         description: "Optional status filter."
    //       }
    //     },
    //     required: ["projectId"]
    //   }
    // },
    {
      name: "describe_schema",
      description: "Returns the database schema: all queryable models with their fields, field types, enum values, and relations. Call this FIRST whenever you need to run a custom database query with query_database and are unsure of the exact model or field names. Read-only.",
      parameters: { type: "object", properties: {} }
    },
    {
      name: "query_database",
      description: "Run a READ-ONLY database query against any model in the CRM. Use for anything the simpler tools can't do — filtering by any field, date ranges, sorting, counts, grouping, joins via relations. ALWAYS call describe_schema first if unsure of model/field names; never assume field names. READ-ONLY — cannot create/update/delete. IMPORTANT: to rank a parent by how many children it has (e.g. clients with the most projects), do NOT use groupBy with _count on a relation. Instead query the CHILD model and groupBy the foreign key — e.g. query Project groupBy ['clientId'] with _count, then look up the client names. groupBy._count only counts rows, not relations.",
      parameters: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "PascalCase model name from describe_schema, e.g. 'Lead', 'Deal', 'Task', 'Attendance', 'Invoice'."
          },
          operation: {
            type: "string",
            enum: ["findMany", "findFirst", "findUnique", "count", "groupBy", "aggregate"],
            description: "Read operation. Default findMany."
          },
          args: {
            type: "object",
            description: "Prisma query args as an object: { where, select, include, orderBy, take, skip, by, _count, _sum, _avg, _min, _max }. Use camelCase field names. 'take' is capped at 100. Example: { where: { status: 'CONVERTED' }, orderBy: { createdAt: 'desc' }, take: 10 }. For groupBy: { by: ['status'], _count: true }."
          }
        },
        required: ["model"]
      }
    }
  ];

  /**
   * Get raw AI settings from cache or DB.
   */
  async #getAiConfig() {
    return cache.get("settings:raw", async () => {
      let settings = await prisma.settings.findUnique({ where: { id: "default" } });
      if (!settings) settings = await prisma.settings.create({ data: { id: "default" } });
      return settings;
    }, 600);
  }

  /**
   * Get or create a cached GoogleGenAI client.
   */
  #getGeminiClient(apiKey) {
    if (!this.#geminiClient || this.#geminiKey !== apiKey) {
      this.#geminiClient = new GoogleGenAI({ apiKey });
      this.#geminiKey = apiKey;
    }
    return this.#geminiClient;
  }

  /**
   * Get or create a cached OpenAI client.
   */
  #getOpenAIClient(apiKey, baseURL) {
    if (!this.#openaiClient || this.#openaiKey !== apiKey || this.#openaiBaseUrl !== baseURL) {
      this.#openaiClient = new OpenAI({
        apiKey,
        ...(baseURL && { baseURL }),
      });
      this.#openaiKey = apiKey;
      this.#openaiBaseUrl = baseURL;
    }
    return this.#openaiClient;
  }

  /**
   * Main generate function — calls the configured AI provider.
   *
   * @param {Object} opts
   * @param {string}  opts.systemPromptSlug  — Slug of the system prompt to use
   * @param {string}  opts.userPrompt        — The user's input/question
   * @param {Object}  [opts.context]         — Additional context data (merged into prompt)
   * @param {boolean} [opts.structured]       — Whether to request structured JSON output (default: true)
   * @param {boolean} [opts.enableTools]      — Whether to enable tool calling (default: false)
   * @returns {Promise<Object>} Parsed JSON response or raw text
   */
  async generate({ systemPromptSlug, userPrompt, context = {}, structured = true, enableTools = false }) {
    const config = await this.#getAiConfig();

    if (!config.aiProvider || config.aiProvider === "NONE") {
      throw ApiError.badRequest("AI is not configured. Please set up an AI provider in Settings.");
    }
    if (!config.aiApiKey) {
      throw ApiError.badRequest("AI API key is missing. Please configure it in Settings.");
    }

    // Get system prompt
    const sysPrompt = await systemPromptService.getPromptBySlug(systemPromptSlug);
    if (!sysPrompt.isActive) {
      throw ApiError.badRequest(`System prompt "${systemPromptSlug}" is disabled.`);
    }

    // Build the full system message
    let systemMessage = sysPrompt.prompt;

    // Append context if provided (but not if tools are enabled - tools handle context)
    if (Object.keys(context).length > 0 && !enableTools) {
      systemMessage += "\n\n## Provided Context\n```json\n" + JSON.stringify(context, null, 2) + "\n```";
    }

    // Parse response schema if structured output is requested
    let responseSchema = null;
    if (structured && sysPrompt.responseSchema) {
      try {
        responseSchema = JSON.parse(sysPrompt.responseSchema);
      } catch {
        console.warn("[AiService] Failed to parse response schema for", systemPromptSlug);
      }
    }

    // Route to the correct provider
    const provider = config.aiProvider.toUpperCase();
    let result;

    if (provider === "GEMINI") {
      result = await this.#callGemini(config, systemMessage, userPrompt, responseSchema, enableTools);
    } else if (provider === "OPENAI") {
      result = await this.#callOpenAI(config, systemMessage, userPrompt, responseSchema, enableTools);
    } else if (provider === "CUSTOM") {
      result = await this.#callCustom(config, systemMessage, userPrompt, responseSchema, enableTools);
    } else {
      throw ApiError.badRequest(`Unknown AI provider: ${config.aiProvider}`);
    }

    return result;
  }

  /**
   * Generate with tool calling support.
   * AI can call tools up to maxTurns times.
   */
  async generateWithTools({
    systemPromptSlug,
    userPrompt,
    maxTurns = 2,
    history = [],
    trace = null,
    extraTools = [],
    webSearch = false,
  }) {
    const config = await this.#getAiConfig();

    if (!config.aiProvider || config.aiProvider === "NONE") {
      throw ApiError.badRequest("AI is not configured. Please set up an AI provider in Settings.");
    }
    if (!config.aiApiKey) {
      throw ApiError.badRequest("AI API key is missing. Please configure it in Settings.");
    }

    // Get system prompt
    const sysPrompt = await systemPromptService.getPromptBySlug(systemPromptSlug);
    if (!sysPrompt.isActive) {
      throw ApiError.badRequest(`System prompt "${systemPromptSlug}" is disabled.`);
    }

    const systemMessage = sysPrompt.prompt;

    // Route to the correct provider
    const provider = config.aiProvider.toUpperCase();

    // Caller-supplied tools plus, when the owner has turned it on, live web
    // search. Built per request: the search budget is a closure over this
    // array, so two concurrent chats cannot spend each other's allowance.
    const tools = [...extraTools];
    const webSearchTool = this.#webSearchTool(config, provider, webSearch);
    if (webSearchTool) tools.push(webSearchTool);

    if (provider === "GEMINI") {
      return this.#callGeminiWithTools(config, systemMessage, userPrompt, maxTurns, history, trace, tools);
    } else if (provider === "OPENAI") {
      return this.#callOpenAIWithTools(config, systemMessage, userPrompt, maxTurns, history, trace, tools);
    } else if (provider === "CUSTOM") {
      return this.#callCustomWithTools(config, systemMessage, userPrompt, maxTurns, history, trace, tools);
    } else {
      throw ApiError.badRequest(`Unknown AI provider: ${config.aiProvider}`);
    }
  }

  /**
   * Call OpenAI chat completions, adapting to what the chosen model accepts.
   *
   * Newer models reject `max_tokens` in favour of `max_completion_tokens`, and
   * the reasoning models reject any `temperature` other than the default. Rather
   * than keep a list of model names — which goes stale the moment a model ships
   * — the rejected parameter is read out of the 400 and the call retried without
   * it. What worked is remembered so the cost is paid once per process.
   *
   * @param {object} client OpenAI SDK client
   * @param {object} body   chat.completions.create body
   */
  /**
   * Learn a rejected parameter from a 400 and record how to avoid it.
   *
   * @returns {object|null} the updated quirks, or null if nothing was learned
   */
  #learnQuirk(message, quirks) {
    const msg = String(message || "");
    const next = { ...quirks };
    let learned = false;

    if (!next.useMaxCompletionTokens && /max_tokens/i.test(msg) && /max_completion_tokens|not supported|unsupported/i.test(msg)) {
      next.useMaxCompletionTokens = true;
      learned = true;
    }
    if (!next.noTemperature && /temperature/i.test(msg) && /unsupported|not support/i.test(msg)) {
      next.noTemperature = true;
      learned = true;
    }
    return learned ? next : null;
  }

  /** Apply learned quirks to a request body. */
  #applyQuirks(body, quirks = {}) {
    const out = { ...body };
    if (quirks.useMaxCompletionTokens && out.max_tokens !== undefined) {
      out.max_completion_tokens = out.max_tokens;
      delete out.max_tokens;
    }
    if (quirks.noTemperature) delete out.temperature;
    return out;
  }

  /**
   * Call OpenAI chat completions, adapting to what the chosen model accepts.
   *
   * Newer models reject `max_tokens` in favour of `max_completion_tokens`, and
   * the reasoning models reject any `temperature` other than the default. Rather
   * than keep a list of model names — which goes stale the moment a model ships
   * — the rejected parameter is read out of the 400 and the call retried. The
   * API reports one bad parameter at a time, so this loops, and what it learns
   * is remembered per model so the cost is paid once per process.
   *
   * @param {object} client OpenAI SDK client
   * @param {object} body   chat.completions.create body
   */
  async #openAiChat(client, body) {
    const key = body.model;
    let quirks = this.#modelQuirks.get(key) || {};

    // One attempt, plus one per parameter we might have to drop.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await client.chat.completions.create(this.#applyQuirks(body, quirks));
      } catch (error) {
        const learned = this.#learnQuirk(error?.message, quirks);
        if (!learned) throw error;

        quirks = learned;
        this.#modelQuirks.set(key, quirks);
      }
    }

    // Every known quirk applied and it still refused — let the real error out.
    return client.chat.completions.create(this.#applyQuirks(body, quirks));
  }

  /**
   * Same adaptation for an OpenAI-compatible server reached over plain fetch.
   * Returns { res, data }; the caller decides what a non-ok response means.
   */
  async #customChat(config, body) {
    const key = `custom:${body.model}`;
    let quirks = this.#modelQuirks.get(key) || {};

    const send = async (payload) => {
      const res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.aiApiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    };

    let result = await send(this.#applyQuirks(body, quirks));

    for (let attempt = 0; attempt < 2 && !result.res.ok; attempt++) {
      const learned = this.#learnQuirk(result.data?.error?.message, quirks);
      if (!learned) break;

      quirks = learned;
      this.#modelQuirks.set(key, quirks);
      result = await send(this.#applyQuirks(body, quirks));
    }

    return result;
  }

  /**
   * List the models the configured provider actually offers.
   *
   * Every provider publishes a catalogue, so the settings screen never has to
   * ship a hand-maintained list that goes stale the moment a model ships.
   *
   * @param {object} override optional { provider, apiKey, baseUrl } so the UI can
   *   list models for a key that has been typed but not saved yet.
   */
  async listModels(override = {}) {
    const config = await this.#getAiConfig();

    const provider = (override.provider || config.aiProvider || "NONE").toUpperCase();
    // The settings screen shows the saved key masked ("sk-proj••••"). Sending
    // that back would put non-ASCII into an Authorization header, so anything
    // that is not a usable key falls back to the stored one.
    const apiKey = this.#usableKey(override.apiKey) || config.aiApiKey;
    const baseUrl = override.baseUrl || config.aiBaseUrl;

    if (!provider || provider === "NONE") {
      throw ApiError.badRequest("Pick an AI provider first.");
    }
    if (!apiKey && provider !== "CUSTOM") {
      throw ApiError.badRequest("Enter an API key to load the model list.");
    }
    if (apiKey && !this.#usableKey(apiKey)) {
      throw ApiError.badRequest(
        "The saved API key looks masked or malformed. Paste the full key, then load the models."
      );
    }

    if (provider === "GEMINI") return this.#listGeminiModels(apiKey);
    if (provider === "OPENAI") return this.#listOpenAIModels(apiKey, config.aiBaseUrl);
    if (provider === "CUSTOM") return this.#listCustomModels(apiKey, baseUrl);

    throw ApiError.badRequest(`Unknown AI provider: ${provider}`);
  }

  /**
   * An API key is only usable if it is printable ASCII — HTTP headers cannot
   * carry anything else, and a masked key is the common way this goes wrong.
   *
   * @returns {string|null} the key, or null if it cannot be sent
   */
  #usableKey(key) {
    if (!key || typeof key !== "string") return null;
    const trimmed = key.trim();
    if (!trimmed) return null;
    return /^[\x20-\x7E]+$/.test(trimmed) ? trimmed : null;
  }

  /**
   * Gemini publishes its catalogue over REST. Only models that can actually run
   * a generateContent call are useful here — the list also carries embedding
   * and token-counting models.
   */
  async #listGeminiModels(apiKey) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw ApiError.badRequest(
        `Gemini rejected the model list request (${res.status}). ${body.slice(0, 200)}`
      );
    }

    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({
        // The API returns "models/gemini-2.5-flash"; the SDK wants the bare id.
        id: String(m.name || "").replace(/^models\//, ""),
        label: m.displayName || String(m.name || "").replace(/^models\//, ""),
        description: m.description || null,
        inputTokenLimit: m.inputTokenLimit ?? null,
        outputTokenLimit: m.outputTokenLimit ?? null,
      }))
      .filter((m) => m.id);

    return { provider: "GEMINI", count: models.length, models: this.#sortModels(models) };
  }

  /** OpenAI's /v1/models returns everything on the account, including non-chat models. */
  async #listOpenAIModels(apiKey, baseUrl) {
    const client = this.#getOpenAIClient(apiKey, baseUrl || undefined);
    const res = await client.models.list();

    const models = (res?.data || [])
      .map((m) => ({
        id: m.id,
        label: m.id,
        created: m.created ? new Date(m.created * 1000).toISOString() : null,
      }))
      .filter((m) => m.id && this.#isChatModel(m.id));

    return { provider: "OPENAI", count: models.length, models: this.#sortModels(models) };
  }

  /** Any OpenAI-compatible server exposes GET {baseUrl}/models. */
  async #listCustomModels(apiKey, baseUrl) {
    if (!baseUrl) throw ApiError.badRequest("Set the Base URL before loading models.");

    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw ApiError.badRequest(
        `${url} returned ${res.status}. ${body.slice(0, 200)}`
      );
    }

    const data = await res.json();
    // Most servers mirror OpenAI's { data: [...] }; a few return a bare array.
    const rows = Array.isArray(data) ? data : data.data || data.models || [];
    const models = rows
      .map((m) => (typeof m === "string" ? { id: m, label: m } : { id: m.id || m.name, label: m.id || m.name }))
      .filter((m) => m.id);

    return { provider: "CUSTOM", count: models.length, models: this.#sortModels(models) };
  }

  /** Drop the models that cannot hold a chat: embeddings, audio, images, moderation. */
  #isChatModel(id) {
    return !/(embedding|whisper|tts|dall-e|moderation|audio|image|realtime|transcribe|search|similarity|edit)/i.test(id);
  }

  /** Newest-looking first, then alphabetical — the list is long. */
  #sortModels(models) {
    return [...models].sort((a, b) => {
      if (a.created && b.created) return b.created.localeCompare(a.created);
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  }

  /**
   * Convenience: CRM Search Assistant — searches the DB then asks AI to interpret results.
   */
  async searchAndAnswer(question) {
    // Step 1: Search the CRM
    const searchResults = await searchService.globalSearch(question, 10);

    // Step 2: Ask AI to interpret
    const result = await this.generate({
      systemPromptSlug: "crm-search-assistant",
      userPrompt: question,
      context: {
        searchResults: {
          users: searchResults.users,
          leads: searchResults.leads,
          deals: searchResults.deals,
          clients: searchResults.clients,
          projects: searchResults.projects,
          teams: searchResults.teams,
          services: searchResults.services,
          counts: searchResults.counts,
        },
      },
      structured: true,
    });

    return result;
  }

  // ─── Provider Implementations ────────────────────────

  /**
   * Google Gemini via @google/genai SDK.
   */
  async #callGemini(config, systemMessage, userPrompt, responseSchema) {
    const model = config.aiModel || "gemini-2.0-flash";

    try {
      const ai = this.#getGeminiClient(config.aiApiKey);

      // Build generation config
      const generationConfig = {
        temperature: config.aiTemperature ?? 0.7,
        maxOutputTokens: config.aiMaxTokens ?? 4096,
      };

      // Add structured output (JSON mode) if schema is provided
      if (responseSchema) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = responseSchema;
      }

      const response = await ai.models.generateContent({
        model,
        contents: `${systemMessage}\n\n---\n\nUser Request:\n${userPrompt}`,
        config: generationConfig,
      });

      const text = response.text || "";

      // Parse structured JSON or return raw
      if (responseSchema) {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }

      return { raw: text };
    } catch (error) {
      console.error("[AiService:Gemini] Error:", error.message);
      throw ApiError.badRequest(error.message || "Gemini API call failed");
    }
  }

  /**
   * OpenAI via official openai SDK.
   */
  async #callOpenAI(config, systemMessage, userPrompt, responseSchema) {
    const model = config.aiModel || "gpt-4o-mini";
    const baseURL = config.aiBaseUrl || undefined; // SDK defaults to https://api.openai.com/v1

    try {
      const client = this.#getOpenAIClient(config.aiApiKey, baseURL);

      const requestBody = {
        model,
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userPrompt },
        ],
        temperature: config.aiTemperature ?? 0.7,
        max_tokens: config.aiMaxTokens ?? 4096,
      };

      // Add structured output format if schema is provided
      if (responseSchema) {
        requestBody.response_format = {
          type: "json_schema",
          json_schema: {
            name: "structured_response",
            strict: false,
            schema: responseSchema,
          },
        };
      }

      const completion = await this.#openAiChat(client, requestBody);

      const text = completion.choices?.[0]?.message?.content || "";

      // Parse structured JSON or return raw
      if (responseSchema) {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }

      return { raw: text };
    } catch (error) {
      console.error("[AiService:OpenAI] Error:", error.message);
      throw ApiError.badRequest(error.message || "OpenAI API call failed");
    }
  }

  /**
   * Turn a final OpenAI message into the shape the copilot expects.
   *
   * An empty body is not "no answer found". The reasoning models spend
   * max_completion_tokens on their own reasoning, so a long request can burn
   * the whole budget and return nothing at all — which needs saying, because
   * the fix is to raise Max Tokens or ask for less.
   */
  #finishOpenAI(content, finishReason) {
    const text = (content || "").trim();

    if (!text) {
      return {
        error:
          finishReason === "length"
            ? "The reply ran out of tokens before any text was written. Raise Max Tokens in AI settings, or ask for a smaller part at a time."
            : "The AI returned an empty reply. Try asking again, more specifically.",
      };
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text, truncated: finishReason === "length" };
    }
  }

  /**
   * Custom OpenAI-compatible provider via raw fetch.
   * Stays as fetch since custom endpoints may not be fully SDK-compatible.
   */
  async #callCustom(config, systemMessage, userPrompt, responseSchema) {
    if (!config.aiBaseUrl) {
      throw ApiError.badRequest("Custom AI provider requires a Base URL in Settings.");
    }

    const model = config.aiModel || "default";

    const body = {
      model,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userPrompt },
      ],
      temperature: config.aiTemperature ?? 0.7,
      max_tokens: config.aiMaxTokens ?? 4096,
    };

    if (responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "structured_response",
          strict: false,
          schema: responseSchema,
        },
      };
    }

    const { res, data } = await this.#customChat(config, body);

    if (!res.ok) {
      console.error("[AiService:Custom] Error:", JSON.stringify(data));
      throw ApiError.badRequest(data.error?.message || "Custom AI API call failed");
    }

    const text = data.choices?.[0]?.message?.content || "";

    if (responseSchema) {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    }

    return { raw: text };
  }

  // ─── Tool Execution ─────────────────────────────────────

  /**
   * Execute a tool by name with given arguments (logs the call + result).
   */
  /**
   * Run one tool call, logging it and — when a trace array is supplied —
   * recording what was asked and what came back.
   *
   * The trace is stored on the chat message so a bad answer can be explained
   * afterwards: which queries ran, in what order, and what they returned. Args
   * and results are capped, since a single query can carry a hundred rows and
   * the trace lives in the database alongside every message.
   *
   * @param {string} toolName
   * @param {object} args
   * @param {Array|null} trace collected per request; mutated in place
   */
  async #executeTool(toolName, args = {}, trace = null, extraTools = []) {
    const started = Date.now();
    const argsJson = JSON.stringify(args ?? {});
    console.log(`[Copilot Tool →] ${toolName}`, argsJson);

    try {
      const result = await this.#runTool(toolName, args, extraTools);
      const ms = Date.now() - started;

      // What the result actually contained, in the caller's own words.
      const summary = {};
      if (Array.isArray(result?.rows)) summary.rows = result.rows.length;
      if (typeof result?.total === "number") summary.total = result.total;
      if (typeof result?.groups === "number") summary.groups = result.groups;
      if (result?.truncated) summary.truncated = true;
      if (result?.result !== undefined && !Array.isArray(result.result)) {
        summary.result = result.result;
      }

      const size = Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`[Copilot Tool ✓] ${toolName} (${ms}ms)${size ? " " + size : ""}`);

      trace?.push({
        tool: toolName,
        model: args?.model || null,
        operation: args?.operation || null,
        args: argsJson.slice(0, TRACE_LIMITS.args),
        ok: true,
        ms,
        summary,
        // A short preview only — enough to see what shape came back.
        preview: JSON.stringify(result ?? null).slice(0, TRACE_LIMITS.preview),
      });

      return result;
    } catch (err) {
      const ms = Date.now() - started;
      console.error(`[Copilot Tool ✗] ${toolName} (${ms}ms): ${err.message}`);

      trace?.push({
        tool: toolName,
        model: args?.model || null,
        operation: args?.operation || null,
        args: argsJson.slice(0, TRACE_LIMITS.args),
        ok: false,
        ms,
        error: String(err.message).slice(0, TRACE_LIMITS.error),
      });

      throw err;
    }
  }

  async #runTool(toolName, args = {}, extraTools = []) {
    // Caller-supplied tools win over the built-ins, so a copilot action or web
    // search resolves without every provider path having to know about it.
    const extra = extraTools.find((t) => t.name === toolName);
    if (extra) return await extra.handler(args || {});

    switch (toolName) {
      case "global_search":
        return await searchService.globalSearch(args.query || "", args.limit || 10);

      case "get_overall_stats":
        return await this.#getOverallStats();

      case "list_entities":
        return await this.#listEntities(args.entity, args.status, args.limit);

      case "get_lead_details":
        return await prisma.lead.findUnique({
          where: { id: args.id },
          include: { assignee: true, createdBy: true }
        });

      case "get_deal_details":
        return await prisma.deal.findUnique({
          where: { id: args.id },
          include: { lead: true, assignee: true }
        });

      case "get_client_details":
        return await prisma.client.findUnique({
          where: { id: args.id },
          include: { accountManager: true }
        });

      case "get_project_details":
        return await prisma.project.findUnique({
          where: { id: args.id },
          include: { client: true, accountManager: true }
        });

      case "list_project_tasks": {
        const where = { projectId: args.projectId };
        if (args.status) where.status = args.status;
        const tasks = await prisma.task.findMany({
          where,
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: {
            id: true, title: true, status: true, priority: true, dueDate: true,
            assignee: { select: { firstName: true, lastName: true } },
            milestone: { select: { title: true } },
          },
        });
        return { projectId: args.projectId, count: tasks.length, tasks };
      }

      case "describe_schema":
        return dbQueryService.describeSchema();

      case "query_database": {
        // args.args may arrive as a JSON string from some providers.
        let queryArgs = args.args;
        if (typeof queryArgs === "string") {
          try { queryArgs = JSON.parse(queryArgs); } catch { queryArgs = {}; }
        }
        return dbQueryService.query({
          model: args.model,
          operation: args.operation || "findMany",
          args: queryArgs || {},
        });
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Get overall CRM statistics.
   */
  async #getOverallStats() {
    const [leadCount, dealCount, clientCount, projectCount, userCount, teamCount] = await Promise.all([
      prisma.lead.count(),
      prisma.deal.count(),
      prisma.client.count(),
      prisma.project.count(),
      prisma.user.count({ where: { role: { not: "CLIENT" } } }),
      prisma.team.count(),
    ]);

    // Count by status
    const [leadByStatus, dealByStage, projectByStatus] = await Promise.all([
      prisma.lead.groupBy({ by: ["status"], _count: true }),
      prisma.deal.groupBy({ by: ["stage"], _count: true }),
      prisma.project.groupBy({ by: ["status"], _count: true }),
    ]);

    return {
      counts: { leadCount, dealCount, clientCount, projectCount, userCount, teamCount },
      leadByStatus: leadByStatus.map(s => ({ status: s.status, count: s._count })),
      dealByStage: dealByStage.map(s => ({ stage: s.stage, count: s._count })),
      projectByStatus: projectByStatus.map(s => ({ status: s.status, count: s._count })),
    };
  }

  /**
   * List records of one entity type, optionally filtered by status/stage.
   * Returns compact rows suitable for the AI to summarize.
   */
  async #listEntities(entity, status, limit) {
    const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const orderBy = { createdAt: "desc" };

    switch (entity) {
      case "leads": {
        const where = status ? { status } : {};
        const rows = await prisma.lead.findMany({
          where, take, orderBy,
          select: { id: true, companyName: true, contactName: true, status: true, priority: true, estimatedValue: true, source: true },
        });
        return { entity: "leads", count: rows.length, items: rows };
      }
      case "deals": {
        const where = status ? { stage: status } : {};
        const rows = await prisma.deal.findMany({
          where, take, orderBy,
          select: { id: true, title: true, stage: true, value: true, lead: { select: { companyName: true } } },
        });
        return { entity: "deals", count: rows.length, items: rows };
      }
      case "clients": {
        const where = status ? { status } : {};
        const rows = await prisma.client.findMany({
          where, take, orderBy,
          select: { id: true, companyName: true, contactName: true, status: true, industry: true },
        });
        return { entity: "clients", count: rows.length, items: rows };
      }
      case "projects": {
        const where = status ? { status } : {};
        const rows = await prisma.project.findMany({
          where, take, orderBy,
          select: { id: true, name: true, status: true, budget: true, client: { select: { companyName: true } } },
        });
        return { entity: "projects", count: rows.length, items: rows };
      }
      case "users": {
        const rows = await prisma.user.findMany({
          where: { role: { not: "CLIENT" } }, take, orderBy,
          select: { id: true, firstName: true, lastName: true, email: true, role: true, status: true },
        });
        return { entity: "users", count: rows.length, items: rows };
      }
      case "teams": {
        const rows = await prisma.team.findMany({
          take, orderBy,
          select: { id: true, name: true, _count: { select: { members: true } } },
        });
        return { entity: "teams", count: rows.length, items: rows };
      }
      case "services": {
        const rows = await prisma.service.findMany({
          take, orderBy,
          select: { id: true, name: true, price: true, isActive: true },
        });
        return { entity: "services", count: rows.length, items: rows };
      }
      case "invoices": {
        const where = { isActive: true, ...(status ? { status } : {}) };
        const rows = await prisma.invoice.findMany({
          where, take, orderBy,
          select: {
            id: true, invoiceNumber: true, status: true, total: true, amountPaid: true,
            dueDate: true, issueDate: true,
            project: { select: { name: true } }, client: { select: { companyName: true } },
          },
        });
        return { entity: "invoices", count: rows.length, items: rows };
      }
      case "tasks": {
        const where = status ? { status } : {};
        const rows = await prisma.task.findMany({
          where, take, orderBy,
          select: {
            id: true, title: true, status: true, priority: true, dueDate: true,
            project: { select: { name: true } },
            assignee: { select: { firstName: true, lastName: true } },
          },
        });
        return { entity: "tasks", count: rows.length, items: rows };
      }
      case "meetings": {
        const where = status ? { status } : {};
        const rows = await prisma.meeting.findMany({
          where, take, orderBy: { scheduledAt: "desc" },
          select: { id: true, title: true, status: true, mode: true, scheduledAt: true },
        });
        return { entity: "meetings", count: rows.length, items: rows };
      }
      case "followups": {
        const where = status ? { status } : {};
        const rows = await prisma.followUp.findMany({
          where, take, orderBy: { dueAt: "desc" },
          select: {
            id: true, title: true, type: true, status: true, dueAt: true,
            lead: { select: { companyName: true } },
          },
        });
        return { entity: "followups", count: rows.length, items: rows };
      }
      case "jobs": {
        const where = status ? { status } : {};
        const rows = await prisma.job.findMany({
          where, take, orderBy,
          select: { id: true, title: true, department: true, status: true, type: true, _count: { select: { applications: true } } },
        });
        return { entity: "jobs", count: rows.length, items: rows };
      }
      case "holidays": {
        const rows = await prisma.holiday.findMany({
          take, orderBy: { date: "desc" },
          select: { id: true, name: true, date: true, isOptional: true },
        });
        return { entity: "holidays", count: rows.length, items: rows };
      }
      case "leaverequests": {
        const where = status ? { status } : {};
        const rows = await prisma.leaveRequest.findMany({
          where, take, orderBy,
          select: {
            id: true, status: true, fromDate: true, toDate: true, totalDays: true, reason: true,
            user: { select: { firstName: true, lastName: true } },
            leaveType: { select: { name: true } },
          },
        });
        return { entity: "leaverequests", count: rows.length, items: rows };
      }
      case "announcements": {
        const rows = await prisma.announcement.findMany({
          take, orderBy,
          select: { id: true, title: true, audience: true, isPinned: true, createdAt: true },
        });
        return { entity: "announcements", count: rows.length, items: rows };
      }
      default:
        return { entity, count: 0, items: [], error: "Unknown entity type. Use query_database for this entity." };
    }
  }

  // ─── Tool-Calling Implementations ─────────────────────

  /**
   * Gemini with tool calling (via function calling).
   */
  async #callGeminiWithTools(config, systemMessage, userPrompt, maxTurns = 2, history = [], trace = null, extraTools = []) {
    const model = config.aiModel || "gemini-2.0-flash";

    try {
      const ai = this.#getGeminiClient(config.aiApiKey);

      // Convert tools to Gemini function declarations
      const tools = [...this.#tools, ...extraTools].map(tool => ({
        functionDeclarations: [{
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }]
      }));

      // Earlier turns go in as their own messages. Folding them into the
      // current question makes the model answer the wrong one.
      let messages = [
        { role: "user", parts: [{ text: systemMessage }] },
        { role: "model", parts: [{ text: "Understood. I will use the tools and answer from real data." }] },
        ...history.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: String(m.content || "") }],
        })),
        { role: "user", parts: [{ text: userPrompt }] },
      ];

      // Allow a couple of tool rounds, then force a final text answer.
      for (let turn = 0; turn <= maxTurns; turn++) {
        const lastTurn = turn === maxTurns;
        const response = await ai.models.generateContent({
          model,
          contents: messages,
          config: {
            temperature: config.aiTemperature ?? 0.7,
            maxOutputTokens: config.aiMaxTokens ?? 4096,
            // On the final turn drop tools so the model must reply with text.
            ...(lastTurn ? {} : { tools }),
          },
        });

        const functionCalls = response.functionCalls;
        if (!lastTurn && functionCalls && functionCalls.length > 0) {
          // 1. Record the model's function-call turn.
          const callParts = functionCalls.map((c) => ({
            functionCall: { name: c.name, args: c.args },
          }));
          messages.push({ role: "model", parts: callParts });

          // 2. Execute + record the results as a user(function) turn.
          const respParts = [];
          for (const call of functionCalls) {
            let result;
            try {
              result = await this.#executeTool(call.name, call.args, trace, extraTools);
            } catch (error) {
              result = { error: error.message };
            }
            respParts.push({
              functionResponse: { name: call.name, response: this.#wrapFnResponse(result) },
            });
          }
          messages.push({ role: "user", parts: respParts });
          continue;
        }

        // No (more) tool calls → final text answer.
        const text = response.text || "";
        return this.#parseAiText(text);
      }

      return { raw: "" };
    } catch (error) {
      throw this.#aiError(error, "GeminiTools");
    }
  }

  // Gemini requires functionResponse.response to be an object.
  #wrapFnResponse(result) {
    if (result && typeof result === "object" && !Array.isArray(result)) return result;
    return { result };
  }

  // Normalize provider errors into a clean, user-safe ApiError.
  #aiError(error, providerLabel) {
    const raw = error?.message || "";
    const status = error?.status || error?.code || error?.response?.status;

    // Rate limit / quota exhausted (Gemini 429 RESOURCE_EXHAUSTED, OpenAI 429).
    const isRate =
      status === 429 ||
      /quota|rate.?limit|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(raw);
    if (isRate) {
      // Try to surface the suggested retry delay if present.
      const m = raw.match(/retry in ([\d.]+)s|retryDelay"?:\s*"?(\d+)s/i);
      const secs = m ? Math.ceil(Number(m[1] || m[2])) : null;
      const wait = secs ? ` Please try again in about ${secs}s.` : " Please try again in a moment.";
      console.warn(`[AiService:${providerLabel}] Rate limited (status=${status}, retry=${secs ?? "?"}s):`, raw);
      return ApiError.tooManyRequests
        ? ApiError.tooManyRequests(`The AI is temporarily rate-limited.${wait}`)
        : new ApiError(429, `The AI is temporarily rate-limited.${wait}`);
    }

    // Auth / key issues.
    if (status === 401 || status === 403 || /api key|unauthorized|permission/i.test(raw)) {
      console.error(`[AiService:${providerLabel}] Auth error (status=${status}):`, raw);
      return ApiError.badRequest("AI authentication failed. Please check the API key in Settings.");
    }

    console.error(`[AiService:${providerLabel}] Unhandled AI error:`, {
      status,
      message: raw,
      name: error?.name,
      responseData: error?.response?.data || error?.data,
      stack: error?.stack,
    });
    return ApiError.badRequest("The AI request failed. Please try again.");
  }

  /**
   * Live web search, as an ordinary tool.
   *
   * OpenAI's hosted web_search runs inside a Responses API call, so it cannot
   * simply be added to the chat-completions tool array the copilot uses. It is
   * wrapped as a normal function tool instead and answered by a second, small
   * request. Three things fall out of that, all of them wanted: the call passes
   * through #executeTool so it lands in the trace like any other tool; the
   * copilot keeps working when the provider is Gemini or a custom endpoint
   * (the tool is simply absent); and the searching model is the one configured
   * in Settings rather than a name hard-coded here.
   *
   * Two switches have to agree before the tool exists: the owner allows it at
   * all in Settings, and the person asking turned it on for this message. The
   * second is what stops every routine "how many clients" question paying for a
   * web search it had no use for.
   *
   * Returns null when the tool should not be offered at all.
   */
  #webSearchTool(config, provider, requested) {
    if (!config.aiWebSearchEnabled || !requested) return null;
    // The hosted tool is OpenAI's. A custom base URL may be anything at all,
    // so it is not assumed to implement the Responses API.
    if (provider !== "OPENAI") return null;
    const apiKey = this.#usableKey(config.aiApiKey);
    if (!apiKey) return null;

    // Each search is billed per call on top of the tokens it returns, and the
    // hosted tool may run several lookups per call. A model left unbounded will
    // search once per sub-question on top of that, so the budget is capped per
    // request and refusals are explicit rather than silent.
    let spent = 0;
    const budget = WEB_SEARCH_BUDGET;

    return {
      name: "web_search",
      description: WEB_SEARCH_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for, in plain language.",
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional. Restrict results to these domains, e.g. ['linkedin.com', 'crunchbase.com'].",
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const query = String(args?.query || "").trim();
        if (!query) return { error: "web_search needs a query." };

        if (spent >= budget) {
          return {
            error: `Web search budget for this message is used up (${budget} searches). Answer from what you already have, and say which part you could not verify.`,
          };
        }
        spent++;

        const domains = Array.isArray(args?.domains)
          ? args.domains.map((d) => String(d)).filter(Boolean).slice(0, 100)
          : [];

        const client = this.#getOpenAIClient(apiKey, config.aiBaseUrl || undefined);
        const res = await client.responses.create({
          model: config.aiModel,
          input: query,
          tools: [
            {
              type: "web_search",
              search_context_size: "medium",
              ...(domains.length && { filters: { allowed_domains: domains } }),
            },
          ],
          include: ["web_search_call.action.sources"],
        });

        return {
          query,
          answer: res.output_text || "",
          sources: this.#webSearchSources(res),
          searchesLeft: budget - spent,
        };
      },
    };
  }

  /**
   * Pull the consulted URLs out of a Responses result.
   *
   * They arrive in two places — the sources attached to each web_search_call,
   * and url_citation annotations on the text — and neither is guaranteed to be
   * populated, so both are read and the union de-duplicated by URL.
   */
  #webSearchSources(res) {
    const seen = new Map();

    const add = (url, title) => {
      if (!url || seen.has(url)) return;
      seen.set(url, { url, title: title || url });
    };

    for (const item of res?.output || []) {
      for (const src of item?.action?.sources || []) add(src?.url, src?.title);
      for (const part of item?.content || []) {
        for (const ann of part?.annotations || []) {
          if (ann?.type === "url_citation") add(ann.url, ann.title);
        }
      }
    }

    return [...seen.values()].slice(0, WEB_SEARCH_MAX_SOURCES);
  }

  /**
   * The core read tools, for display — not for calling. Kept separate from
   * #tools itself so a catalog listing can never accidentally hand out a
   * callable reference.
   */
  coreToolCatalog() {
    const labels = { describe_schema: "Inspect database schema", query_database: "Query CRM data" };
    return this.#tools.map((t) => ({ name: t.name, label: labels[t.name] || t.name, description: t.description }));
  }

  /** web_search's description, independent of whether it is currently enabled. */
  webSearchCatalogEntry() {
    return { name: "web_search", description: WEB_SEARCH_DESCRIPTION };
  }

  // Wrap the internal tool defs into OpenAI/Custom function-calling format.
  #openAiTools(extraTools = []) {
    return [...this.#tools, ...extraTools].map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  // Parse a model text reply that may be JSON (possibly fenced) or plain text.
  #parseAiText(text) {
    if (!text) return { raw: "" };
    const cleaned = String(text).replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return { raw: text };
    }
  }

  /**
   * OpenAI with tool calling (function calling).
   */
  async #callOpenAIWithTools(config, systemMessage, userPrompt, maxTurns = 2, history = [], trace = null, extraTools = []) {
    const model = config.aiModel || "gpt-4o-mini";
    const baseURL = config.aiBaseUrl || undefined;

    try {
      const client = this.#getOpenAIClient(config.aiApiKey, baseURL);

      // OpenAI function-calling format: { type:"function", function:{...} }
      const tools = this.#openAiTools(extraTools);

      let messages = [
        { role: "system", content: systemMessage },
        ...history.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content || ""),
        })),
        { role: "user", content: userPrompt },
      ];

      let turns = 0;

      while (turns < maxTurns) {
        // On the final round the tools are withheld, or the model can spend the
        // last turn on another call and never produce an answer.
        const lastTurn = turns === maxTurns - 1;

        const completion = await this.#openAiChat(client, {
          model,
          messages,
          ...(lastTurn ? {} : { tools, tool_choice: "auto" }),
          temperature: config.aiTemperature ?? 0.7,
          max_tokens: config.aiMaxTokens ?? 4096,
        });

        const choice = completion.choices[0];
        const finishReason = choice.finish_reason;

        // Add assistant message
        messages.push(choice.message);

        // Check if model wants to call a function
        if (finishReason === "tool_calls" && choice.message.tool_calls) {
          turns++;

          // Execute each tool call
          for (const toolCall of choice.message.tool_calls) {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const result = await this.#executeTool(toolCall.function.name, args, trace, extraTools);
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify(result)
              });
            } catch (error) {
              messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: error.message })
              });
            }
          }
        } else {
          return this.#finishOpenAI(choice.message.content, finishReason);
        }
      }

      // Out of tool rounds. Ask once more with no tools attached so there is
      // always a written answer, rather than an error the user cannot act on.
      const final = await this.#openAiChat(client, {
        model,
        messages,
        temperature: config.aiTemperature ?? 0.7,
        max_tokens: config.aiMaxTokens ?? 4096,
      });
      const lastChoice = final.choices?.[0];
      return this.#finishOpenAI(lastChoice?.message?.content, lastChoice?.finish_reason);
    } catch (error) {
      throw this.#aiError(error, "OpenAITools");
    }
  }

  /**
   * Custom provider with tool calling.
   * Uses OpenAI-compatible function calling format.
   */
  async #callCustomWithTools(config, systemMessage, userPrompt, maxTurns = 2, history = [], trace = null, extraTools = []) {
    if (!config.aiBaseUrl) {
      throw ApiError.badRequest("Custom AI provider requires a Base URL in Settings.");
    }

    const model = config.aiModel || "default";

    // Convert tools to OpenAI-compatible function-calling format
    const tools = this.#openAiTools(extraTools);

    let messages = [
      { role: "system", content: systemMessage },
      ...history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || ""),
      })),
      { role: "user", content: userPrompt },
    ];

    let turns = 0;

    while (turns < maxTurns) {
      const body = {
        model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: config.aiTemperature ?? 0.7,
        max_tokens: config.aiMaxTokens ?? 4096,
      };

      const { res, data } = await this.#customChat(config, body);

      if (!res.ok) {
        const err = new Error(data.error?.message || JSON.stringify(data));
        err.status = res.status;
        throw this.#aiError(err, "CustomTools");
      }

      const choice = data.choices[0];
      const finishReason = choice.finish_reason;

      // Add assistant message
      messages.push(choice.message);

      // Check if model wants to call a function
      if (finishReason === "tool_calls" && choice.message.tool_calls) {
        turns++;

        // Execute each tool call
        for (const toolCall of choice.message.tool_calls) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await this.#executeTool(toolCall.function.name, args, trace, extraTools);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result)
            });
          } catch (error) {
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: error.message })
            });
          }
        }
      } else {
        // No tool calls, return the response
        const text = choice.message.content || "";
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }
    }

    // Max turns reached
    return { error: "Max tool call iterations reached" };
  }
}

export default new AiService();
