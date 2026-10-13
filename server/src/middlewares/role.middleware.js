import { ApiError } from "../utils/apiError.js";

/**
 * Restricts access to specific roles.
 * Usage: authorize("OWNER", "ADMIN")
 */
const authorize = (...allowedRoles) => {
  const middleware = (req, _res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized("Authentication required"));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        ApiError.forbidden(
          `Role '${req.user.role}' does not have permission to access this resource`
        )
      );
    }

    next();
  };
  // Read by scripts/generate-openapi.js to document the route. No runtime effect.
  middleware.roles = allowedRoles;
  return middleware;
};

export default authorize;
