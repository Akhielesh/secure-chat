// ULID helper
const { ulid } = require('ulid');

function generateUlid() {
  return ulid();
}

module.exports = { generateUlid };


