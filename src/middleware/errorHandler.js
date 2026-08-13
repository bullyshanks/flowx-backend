// ── Global error handler — last middleware in the chain ──

const errorHandler = (err, req, res, next) => {
  console.error('🔥 Error:', err);

  // Prisma known errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      message: `Duplicate value for ${err.meta?.target?.join(', ') || 'a unique field'}`,
    });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, message: 'Record not found' });
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: err.message });
  }

  const status = err.status || 500;
  // Below 500, err.message is almost always something a controller set on
  // purpose for the client to read. At 500 it's usually a raw Prisma/Node
  // error — those name models, fields, and sometimes the failing value
  // (e.g. an invalid enum sent as a query param), which is exactly the kind
  // of internal detail that shouldn't leave the server. Stack traces stay
  // dev-only as before.
  const message = status < 500 || process.env.NODE_ENV === 'development'
    ? err.message || 'Internal server error'
    : 'Internal server error';

  res.status(status).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
