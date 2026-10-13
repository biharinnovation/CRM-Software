#!/usr/bin/env node
/**
 * Generate docs/openapi.json from the running route table.
 *
 * Runs automatically on every server start (see server.js), and can be run
 * by hand with `npm run docs:openapi`.
 *
 * Nothing here is written by hand per endpoint. The script loads the real
 * Express app, walks every mounted router, and reads each route's:
 *   - method and path                → from the router itself
 *   - auth requirement               → whether `authenticate` is in its chain
 *   - allowed roles                  → `authorize(...)` (tagged with .roles)
 *   - path / query / body schemas    → its `validate(zodSchema)` (tagged with .schema)
 *   - operation name, 200 vs 201     → its controller handler (via catchAsync's .handler)
 * so the spec cannot drift from the code — re-run it after any route change:
 *
 *   npm run docs:openapi
 *
 * Response bodies are documented as the shared success/error envelopes. The
 * shape of `data` is not declared anywhere in the code, so it is not invented here.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(SERVER_ROOT, "docs", "openapi.json");

// The bare root just redirects to the web app; it is not part of the API.
const EXCLUDED_PATHS = new Set(["/"]);

// ─── zod (v3) → JSON Schema (OpenAPI 3.1 dialect) ───────────────────────────

function nullable(s) {
  if (typeof s.type === "string") return { ...s, type: [s.type, "null"] };
  return { anyOf: [s, { type: "null" }] };
}

function zodToJson(schema) {
  const def = schema?._def;
  if (!def) return {};
  let out;

  switch (def.typeName) {
    case "ZodString": {
      out = { type: "string" };
      for (const c of def.checks || []) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        else if (c.kind === "length") out.minLength = out.maxLength = c.value;
        else if (c.kind === "email") out.format = "email";
        else if (c.kind === "url") out.format = "uri";
        else if (c.kind === "uuid") out.format = "uuid";
        else if (c.kind === "datetime") out.format = "date-time";
        else if (c.kind === "date") out.format = "date";
        else if (c.kind === "regex") out.pattern = c.regex.source;
      }
      break;
    }
    case "ZodNumber": {
      out = { type: def.checks?.some((c) => c.kind === "int") ? "integer" : "number" };
      for (const c of def.checks || []) {
        if (c.kind === "min") out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        else if (c.kind === "max") out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
        else if (c.kind === "multipleOf") out.multipleOf = c.value;
      }
      break;
    }
    case "ZodBigInt": out = { type: "integer" }; break;
    case "ZodBoolean": out = { type: "boolean" }; break;
    case "ZodDate": out = { type: "string", format: "date-time" }; break;
    case "ZodLiteral": {
      const v = def.value;
      out = { type: v === null ? "null" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string", const: v };
      break;
    }
    case "ZodEnum": out = { type: "string", enum: [...def.values] }; break;
    case "ZodNativeEnum":
      out = { enum: Object.values(def.values).filter((v) => typeof def.values[v] !== "number") };
      break;
    case "ZodArray": {
      out = { type: "array", items: zodToJson(def.type) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      if (def.exactLength) out.minItems = out.maxItems = def.exactLength.value;
      break;
    }
    case "ZodObject": {
      const shape = def.shape();
      const properties = {};
      const required = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJson(child);
        if (!child.isOptional()) required.push(key);
      }
      out = { type: "object", properties };
      if (required.length) out.required = required;
      break;
    }
    case "ZodRecord": out = { type: "object", additionalProperties: zodToJson(def.valueType) }; break;
    case "ZodTuple": out = { type: "array", prefixItems: def.items.map(zodToJson) }; break;
    case "ZodUnion": out = { anyOf: def.options.map(zodToJson) }; break;
    case "ZodDiscriminatedUnion": out = { oneOf: [...def.options.values()].map(zodToJson) }; break;
    case "ZodIntersection": out = { allOf: [zodToJson(def.left), zodToJson(def.right)] }; break;
    // Wrappers — optionality is expressed by the parent's `required` list.
    case "ZodOptional": out = zodToJson(def.innerType); break;
    case "ZodNullable": out = nullable(zodToJson(def.innerType)); break;
    case "ZodDefault": out = { ...zodToJson(def.innerType), default: def.defaultValue() }; break;
    case "ZodCatch": out = zodToJson(def.innerType); break;
    case "ZodEffects": out = zodToJson(def.schema); break; // preprocess / refine / transform
    case "ZodPipeline": out = zodToJson(def.in); break;
    case "ZodLazy": out = zodToJson(def.getter()); break;
    case "ZodBranded": out = zodToJson(def.type); break;
    case "ZodReadonly": out = zodToJson(def.innerType); break;
    default: out = {}; // ZodAny, ZodUnknown, anything unrecognised: accept anything
  }

  if (def.description) out.description = def.description;
  return out;
}

/** Strip optional/effects/default wrappers to reach the underlying object, if any. */
function unwrapObject(schema) {
  let s = schema;
  for (let i = 0; i < 10 && s?._def; i++) {
    const t = s._def.typeName;
    if (t === "ZodObject") return s;
    s = s._def.innerType || s._def.schema || (t === "ZodPipeline" ? s._def.in : null);
  }
  return null;
}

/**
 * Build the OpenAPI document from the live Express app and write it to
 * docs/openapi.json. Safe to call from a running server: it only reads the
 * route table and the already-loaded modules.
 *
 * @returns {Promise<{file:string, paths:number, operations:number, tags:number, withValidation:number, writesWithoutBodySchema:string[]}>}
 */
export async function generateOpenApi() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "package.json"), "utf8"));
  const { default: app } = await import(pathToFileURL(path.join(SERVER_ROOT, "src/app.js")));
  const { default: authenticate } = await import(
    pathToFileURL(path.join(SERVER_ROOT, "src/middlewares/auth.middleware.js"))
  );
  const { default: config } = await import(pathToFileURL(path.join(SERVER_ROOT, "src/config/index.js")));

  // ─── Controller function → its exported name, for operationIds ─────────────

  const handlerNames = new Map();
  const modulesDir = path.join(SERVER_ROOT, "src/modules");
  for (const dir of fs.readdirSync(modulesDir)) {
    const folder = path.join(modulesDir, dir);
    if (!fs.statSync(folder).isDirectory()) continue;
    for (const file of fs.readdirSync(folder).filter((f) => f.endsWith(".controller.js"))) {
      const { default: controller } = await import(pathToFileURL(path.join(folder, file)));
      if (!controller) continue;
      // Plain objects, and class instances with arrow-function fields (own props)
      // or prototype methods.
      const keys = new Set([
        ...Object.keys(controller),
        ...Object.getOwnPropertyNames(Object.getPrototypeOf(controller) || {}),
      ]);
      for (const key of keys) {
        if (key === "constructor") continue;
        const fn = controller[key];
        if (typeof fn === "function" && !handlerNames.has(fn)) handlerNames.set(fn, key);
      }
    }
  }

  // ─── Walk the Express 4 route table ─────────────────────────────────────────

  /** Recover a static mount path from Express 4's compiled layer regexp. */
  function mountPathOf(layer) {
    if (layer.regexp?.fast_slash) return "";
    const src = layer.regexp?.source || "";
    const m = src.match(/^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
    if (!m) return "";
    return m[1].replace(/\\\//g, "/");
  }

  const routes = [];

  function collectRoute(fullPath, route, inherited) {
    const chain = [...inherited, ...route.stack.map((l) => l.handle)];
    const handler = route.stack[route.stack.length - 1]?.handle;
    const roleSets = chain.filter((h) => Array.isArray(h.roles)).map((h) => h.roles);
    // Several authorize() layers must all pass, so the effective set is their intersection.
    const roles = roleSets.length
      ? roleSets.reduce((acc, set) => acc.filter((r) => set.includes(r)))
      : null;

    for (const method of Object.keys(route.methods).filter((m) => route.methods[m])) {
      routes.push({
        method,
        path: fullPath,
        auth: chain.includes(authenticate),
        roles,
        schemas: chain.filter((h) => h.schema).map((h) => h.schema),
        handler,
      });
    }
  }

  function walk(stack, prefix, inherited) {
    const middleware = [...inherited];
    for (const layer of stack) {
      if (layer.route) {
        // router.get("/") under "/api/x" is "/api/x", not "/api/x/".
        const sub = layer.route.path === "/" && prefix ? "" : layer.route.path;
        collectRoute(prefix + sub, layer.route, middleware);
      } else if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, prefix + mountPathOf(layer), middleware);
      } else if (typeof layer.handle === "function") {
        // router.use(fn) — applies to every route registered after it.
        middleware.push(layer.handle);
      }
    }
  }

  const appStack = app._router?.stack || app.router?.stack;
  if (!appStack) throw new Error("Could not find the Express route table on the app");
  // App-level middleware (helmet, cors, json…) is global plumbing, not per-route
  // auth, so the walk starts with nothing inherited.
  walk(appStack, "", []);

  // ─── Build the document ─────────────────────────────────────────────────────

  const humanize = (name) =>
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/^./, (c) => c.toUpperCase())
      .replace(/\b([A-Z])([a-z]+)/g, (w, a, b, i) => (i === 0 ? w : a.toLowerCase() + b));

  const tagFor = (p) => {
    const seg = p.split("/").filter(Boolean)[1] || "general"; // /api/<seg>/...
    return seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const toOpenApiPath = (p) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

  const paths = {};
  const usedOperationIds = new Set();
  const stats = { operations: 0, withValidation: 0, writesWithoutBodySchema: [] };

  for (const r of routes) {
    if (EXCLUDED_PATHS.has(r.path)) continue;
    const oaPath = toOpenApiPath(r.path);
    const tag = tagFor(r.path);

    // Merge every validate() on the route (there should be at most one).
    const parts = { params: null, query: null, body: null };
    for (const s of r.schemas) {
      const obj = unwrapObject(s);
      if (!obj) continue;
      const shape = obj._def.shape();
      for (const key of ["params", "query", "body"]) if (shape[key]) parts[key] = shape[key];
    }

    const parameters = [];
    const pathParamSchemas = unwrapObject(parts.params)?._def.shape() || {};
    for (const [, name] of oaPath.matchAll(/\{([^}]+)\}/g)) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: pathParamSchemas[name] ? zodToJson(pathParamSchemas[name]) : { type: "string" },
      });
    }
    const queryObj = unwrapObject(parts.query);
    if (queryObj) {
      for (const [name, child] of Object.entries(queryObj._def.shape())) {
        parameters.push({ name, in: "query", required: !child.isOptional(), schema: zodToJson(child) });
      }
    }

    // Name and success code come from the real controller function.
    const inner = r.handler?.handler || r.handler;
    const ctrlName = handlerNames.get(r.handler) || null;
    let operationId = ctrlName ? `${tag.replace(/\s+/g, "")}_${ctrlName}` : `${r.method}_${oaPath}`.replace(/[^\w]+/g, "_");
    while (usedOperationIds.has(operationId)) operationId += "_";
    usedOperationIds.add(operationId);
    const successCode = /\bcreated\s*\(/.test(String(inner)) ? "201" : "200";

    const op = {
      tags: [tag],
      operationId,
      summary: ctrlName ? humanize(ctrlName) : `${r.method.toUpperCase()} ${oaPath}`,
    };

    const notes = [];
    if (r.roles) notes.push(`**Roles:** ${r.roles.join(", ")}`);
    else if (r.auth) notes.push("**Roles:** any authenticated user");
    else notes.push("**Public** — no authentication.");
    op.description = notes.join("\n\n");
    if (r.roles) op["x-roles"] = r.roles;

    if (parameters.length) op.parameters = parameters;

    if (parts.body) {
      op.requestBody = {
        required: !parts.body.isOptional(),
        content: { "application/json": { schema: zodToJson(parts.body) } },
      };
    } else if (["post", "put", "patch"].includes(r.method)) {
      stats.writesWithoutBodySchema.push(`${r.method.toUpperCase()} ${oaPath}`);
    }

    op.responses = {
      [successCode]: { $ref: "#/components/responses/Success" },
      ...(r.schemas.length ? { 400: { $ref: "#/components/responses/ValidationError" } } : {}),
      ...(r.auth ? { 401: { $ref: "#/components/responses/Unauthorized" } } : {}),
      ...(r.roles ? { 403: { $ref: "#/components/responses/Forbidden" } } : {}),
      ...(oaPath.includes("{") ? { 404: { $ref: "#/components/responses/NotFound" } } : {}),
      500: { $ref: "#/components/responses/ServerError" },
    };
    // Bearer auth is the document-wide default; a public route opts out explicitly
    // so "no auth" is never confused with "auth not declared".
    if (!r.auth) op.security = [];

    paths[oaPath] = paths[oaPath] || {};
    paths[oaPath][r.method] = op;
    stats.operations++;
    if (r.schemas.length) stats.withValidation++;
  }

  const sortedPaths = Object.fromEntries(Object.keys(paths).sort().map((k) => [k, paths[k]]));
  const tags = [...new Set(Object.values(sortedPaths).flatMap((ops) => Object.values(ops).flatMap((o) => o.tags)))]
    .sort()
    .map((name) => {
      const ops = Object.values(sortedPaths).flatMap((v) => Object.values(v)).filter((o) => o.tags.includes(name));
      const prefix = Object.keys(sortedPaths).find((k) => Object.values(sortedPaths[k]).some((o) => o.tags.includes(name)));
      const base = prefix ? prefix.split("/").slice(0, 3).join("/") : "";
      return { name, description: `${ops.length} operation${ops.length === 1 ? "" : "s"} under \`${base}\`.` };
    });

  const errorBody = {
    type: "object",
    required: ["success", "message"],
    properties: {
      success: { type: "boolean", const: false },
      message: { type: "string" },
      errors: {
        type: "array",
        description: "Field-level details, present on validation errors.",
        items: {
          type: "object",
          properties: { field: { type: "string" }, message: { type: "string" } },
        },
      },
    },
  };
  const errorResponse = (description, example) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" }, example } },
  });

  const doc = {
    openapi: "3.1.0",
    info: {
      title: `${pkg.name} API`,
      version: pkg.version,
      description: [
        "Generated from the server's live route table by `scripts/generate-openapi.js` — do not edit by hand; run `npm run docs:openapi`.",
        "",
        "**Auth:** send `Authorization: Bearer <accessToken>` (from `POST /api/auth/login`). Each operation lists the roles allowed to call it.",
        "",
        "**Envelope:** every response is `{ success, message, data? }`. The shape of `data` per endpoint is not declared in the code, so it is documented as a free-form value.",
      ].join("\n"),
    },
    servers: [{ url: `http://localhost:${config.port}`, description: "Local development" }],
    security: [{ bearerAuth: [] }],
    tags,
    paths: sortedPaths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        ApiSuccess: {
          type: "object",
          required: ["success", "message"],
          properties: {
            success: { type: "boolean", const: true },
            message: { type: "string" },
            data: { description: "Endpoint-specific payload." },
          },
        },
        ApiError: errorBody,
      },
      responses: {
        Success: {
          description: "Success",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiSuccess" } } },
        },
        ValidationError: errorResponse("Request failed validation", {
          success: false,
          message: "Validation failed — body.name: Required",
          errors: [{ field: "body.name", message: "Required" }],
        }),
        Unauthorized: errorResponse("Missing or invalid access token", { success: false, message: "Access token is required" }),
        Forbidden: errorResponse("Authenticated, but this role may not call this endpoint", {
          success: false,
          message: "Role 'EMPLOYEE' does not have permission to access this resource",
        }),
        NotFound: errorResponse("Resource not found", { success: false, message: "Not found" }),
        ServerError: errorResponse("Unexpected server error", { success: false, message: "Internal server error" }),
      },
    },
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const json = JSON.stringify(doc, null, 2) + "\n";
  // Skip the write when nothing changed, so file watchers and editors are not
  // poked on every restart.
  const previous = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : null;
  if (previous !== json) fs.writeFileSync(OUT_FILE, json);

  return {
    file: OUT_FILE,
    changed: previous !== json,
    paths: Object.keys(sortedPaths).length,
    operations: stats.operations,
    tags: tags.length,
    withValidation: stats.withValidation,
    writesWithoutBodySchema: stats.writesWithoutBodySchema,
  };
}

// ─── CLI: `npm run docs:openapi` ─────────────────────────────────────────────

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await generateOpenApi();
  console.log(`${result.changed ? "Wrote" : "Unchanged"} ${path.relative(process.cwd(), result.file)}`);
  console.log(`  ${result.paths} paths, ${result.operations} operations, ${result.tags} tags`);
  console.log(`  ${result.withValidation} operations have a request schema`);
  if (result.writesWithoutBodySchema.length) {
    console.log(`  ${result.writesWithoutBodySchema.length} write operations have no body validator (body undocumented):`);
    for (const w of result.writesWithoutBodySchema) console.log(`    - ${w}`);
  }
  // The app opens a DB pool on import; nothing else to wait for.
  process.exit(0);
}
