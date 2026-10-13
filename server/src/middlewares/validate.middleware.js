import { ApiError } from "../utils/apiError.js";

/**
 * Validates request body/query/params against a Zod schema.
 * Usage: validate(loginSchema)
 */
const validate = (schema) => {
  const middleware = (req, _res, next) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      // Name the offending field in the message — a bare "Validation failed"
      // says nothing in the log, where the errors array is not printed.
      const summary = errors
        .slice(0, 3)
        .map((e) => `${e.field}: ${e.message}`)
        .join("; ");
      const suffix = errors.length > 3 ? ` (+${errors.length - 3} more)` : "";
      return next(ApiError.badRequest(`Validation failed — ${summary}${suffix}`, errors));
    }

    // Replace req data with parsed (cleaned) values
    req.body = result.data.body ?? req.body;
    req.query = result.data.query ?? req.query;
    req.params = result.data.params ?? req.params;

    next();
  };
  // Read by scripts/generate-openapi.js to document the route. No runtime effect.
  middleware.schema = schema;
  return middleware;
};

export default validate;
