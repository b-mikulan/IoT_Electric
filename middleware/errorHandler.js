function errorHandler(error, req, res, next) {
  console.error(error);

  // EWS can return a SOAP fault with HTTP 200; REST clients must see a failure.
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : error.soapFault ? 502 : 500;
  res.status(status).json({
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
