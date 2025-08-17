/**
 * Parse JSON arrays safely for origins configuration
 * @param {string} json - JSON string to parse
 * @param {string[]} fallback - Fallback array if parsing fails
 * @returns {string[]} Array of validated origins
 */
export function parseOrigins(json, fallback = []) {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v) && v.every(s => typeof s === 'string')) return v;
  } catch {}
  return fallback;
}

/**
 * Validate if an origin is allowed
 * @param {string} origin - Origin to validate
 * @param {string[]} allowedOrigins - Array of allowed origins
 * @returns {boolean} Whether origin is allowed
 */
export function isOriginAllowed(origin, allowedOrigins) {
  if (!origin || !allowedOrigins.length) return false;
  
  // Check exact match
  if (allowedOrigins.includes(origin)) return true;
  
  // Check wildcard subdomain (e.g., *.example.com)
  return allowedOrigins.some(allowed => {
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      return origin.endsWith(domain) || origin === domain;
    }
    return false;
  });
}
