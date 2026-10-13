/**
 * Wraps an async route handler to catch errors
 * and forward them to Express error middleware.
 */
const catchAsync = (fn) => {
  const wrapper = (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
  // Read by scripts/generate-openapi.js (e.g. to tell a 201 create from a 200).
  // No runtime effect.
  wrapper.handler = fn;
  return wrapper;
};

export default catchAsync;
