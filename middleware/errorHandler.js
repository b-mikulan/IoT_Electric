function errorHandler(error, req, res, next) {
  console.error(error);

  res.status(error.status || 500).json({
    error: error.message,
    soapFault: error.soapFault || null,

    // Useful during development, but raw XML must not be exposed in production.
    rawResponse:
      process.env.NODE_ENV === "development"
        ? error.body || null
        : undefined,
  });
}

module.exports = {
  errorHandler,
};
