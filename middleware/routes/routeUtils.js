function asyncRoute(handler) {
  return function routeHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireNonEmptyArray(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    const error = new Error(`${fieldName} must be a non-empty array.`);
    error.status = 400;
    throw error;
  }
}

module.exports = {
  asyncRoute,
  requireNonEmptyArray,
};
