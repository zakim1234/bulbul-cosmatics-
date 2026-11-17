import { ApiError } from '../utils/ApiError.js';

export function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Something went wrong. Please try again.';
  let details = err.details || null;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(' ');
  } else if (err.code === 11000) {
    statusCode = 409;
    const key = Object.keys(err.keyValue || {})[0] || 'value';
    const field = key === 'username' ? 'email' : key; // users sign in with their email
    message = `That ${field} is already in use. Please use a different one.`;
  } else if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid ID provided.';
  }

  if (statusCode >= 500) {
    console.error(err);
    // An unexpected error: its own text is for the server log, not for the
    // person using the system.
    if (!(err instanceof ApiError)) {
      message = 'Something went wrong. Please try again.';
      details = null;
    }
  }

  res.status(statusCode).json({
    success: false,
    message,
    details,
  });
}
