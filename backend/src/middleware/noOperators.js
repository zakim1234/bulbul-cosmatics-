import { ApiError } from '../utils/ApiError.js';

// What a person sends (the JSON body and the ?query) is data, never part of
// a database query: a key starting with "$" ({ "customerId": { "$ne": null } },
// ?category[$exists]=false) would be read by MongoDB as an operator and could
// pick records the request never named. No screen ever sends such a key, so
// a request carrying one is refused before any route sees it.
function hasOperatorKey(root) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    for (const key of Object.keys(value)) {
      if (key.startsWith('$')) return true;
      stack.push(value[key]);
    }
  }
  return false;
}

export function rejectOperatorKeys(req, res, next) {
  if (hasOperatorKey(req.body) || hasOperatorKey(req.query)) {
    return next(new ApiError(400, 'The request contains characters that are not allowed.'));
  }
  next();
}
