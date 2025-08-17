/**
 * Parse and validate allowed origins from environment variables
 * @param {string} origins - Comma-separated origins or JSON array
 * @param {string[]} fallback - Fallback origins if parsing fails
 * @returns {string[]} Array of validated origins
 */
export function parseOrigins(origins, fallback = []) {
  if (!origins) return fallback;
  
  try {
    // Try to parse as JSON first
    if (origins.startsWith('[') && origins.endsWith(']')) {
      const parsed = JSON.parse(origins);
      if (Array.isArray(parsed)) {
        return parsed.filter(origin => typeof origin === 'string' && origin.trim());
      }
    }
    
    // Fallback to comma-separated
    return origins.split(',').map(o => o.trim()).filter(Boolean);
  } catch (error) {
    console.warn('Failed to parse origins:', origins, 'using fallback:', fallback);
    return fallback;
  }
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
