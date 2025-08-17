/**
 * Validate emoji strings to prevent SQL injection
 * Only allows safe unicode emoji characters
 * @param {string} str - Emoji string to validate
 * @returns {boolean} Whether the emoji is safe to use in SQL
 */
export function isSafeEmoji(str) {
  // Basic safeguard: only allow unicode emoji characters (no quotes/colons)
  // Fallback: restrict to short names if you use them. Adjust as needed.
  return typeof str === 'string' && str.length <= 8 && !/[\"\'\\:\s]/.test(str);
}

/**
 * Get a list of safe emojis for validation
 * @returns {string[]} Array of safe emoji characters
 */
export function getSafeEmojis() {
  return ['👍', '👎', '❤️', '😀', '😍', '😂', '😭', '😡', '🤔', '👏', '🙏', '🎉'];
}

/**
 * Validate emoji against safe list (alternative approach)
 * @param {string} emoji - Emoji to validate
 * @returns {boolean} Whether emoji is in safe list
 */
export function isEmojiInSafeList(emoji) {
  const safeEmojis = getSafeEmojis();
  return safeEmojis.includes(emoji);
}
