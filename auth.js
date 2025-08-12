const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function hashPassword(plainPassword) {
  const saltRounds = 10;
  return bcrypt.hashSync(String(plainPassword), saltRounds);
}

function verifyPassword(plainPassword, passwordHash) {
  try {
    return bcrypt.compareSync(String(plainPassword), String(passwordHash));
  } catch (_) {
    return false;
  }
}

function signJwt(payload) {
  // default 24h expiry
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '24h' });
}

function verifyJwt(token) {
  return jwt.verify(String(token || ''), JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
};



