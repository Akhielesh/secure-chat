const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://example.r2.cloudflarestorage.com';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function createPresignedPostUrl({ key, contentType, maxBytes, userId, roomId }) {
  // Enhanced security: strict conditions for presigned POST
  const conditions = [
    ['content-length-range', 1, maxBytes], // Must be at least 1 byte, max specified size
    ['eq', '$Content-Type', contentType], // Exact content-type match (not starts-with)
    ['eq', '$key', key], // Exact key match
    ['eq', '$x-amz-meta-user-id', userId], // User ID metadata
    ['eq', '$x-amz-meta-room-id', roomId], // Room ID metadata
    ['eq', '$x-amz-meta-upload-timestamp', Date.now().toString()], // Upload timestamp
  ];
  
  const fields = { 
    'Content-Type': contentType, 
    key,
    'x-amz-meta-user-id': userId,
    'x-amz-meta-room-id': roomId,
    'x-amz-meta-upload-timestamp': Date.now().toString(),
  };
  
  const { url, fields: postFields } = await createPresignedPost(s3, {
    Bucket: R2_BUCKET,
    Key: key,
    Conditions: conditions,
    Fields: fields,
    Expires: 600, // 10 minutes - reasonable expiry for uploads
  });
  
  return { url, fields: postFields };
}

async function getSignedGetUrl(key, expiresSeconds = 300) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
    { expiresIn: expiresSeconds }
  );
}

// Enhanced MIME type validation with security checks
function validateMimeType(mimeType) {
  // Whitelist of safe MIME types
  const allowedMimeTypes = new Set([
    // Images
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
    // Videos (common formats)
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
    // Audio (common formats)
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm',
    // Documents (safe formats)
    'application/pdf', 'text/plain', 'text/markdown'
  ]);
  
  return allowedMimeTypes.has(mimeType);
}

// File size validation with security limits
function validateFileSize(bytes, maxBytes = 50 * 1024 * 1024) {
  const minBytes = 1;
  const maxBytesLimit = Math.min(maxBytes, 100 * 1024 * 1024); // Cap at 100MB
  
  return Number.isFinite(bytes) && 
         bytes >= minBytes && 
         bytes <= maxBytesLimit;
}

// Enhanced upload validation
function validateUploadRequest({ mimeType, bytes, userId, roomId, maxBytes = 50 * 1024 * 1024 }) {
  const errors = [];
  
  if (!mimeType || typeof mimeType !== 'string') {
    errors.push('Invalid MIME type');
  } else if (!validateMimeType(mimeType)) {
    errors.push('Unsupported file type');
  }
  
  if (!validateFileSize(bytes, maxBytes)) {
    errors.push('Invalid file size');
  }
  
  if (!userId || typeof userId !== 'string') {
    errors.push('Invalid user ID');
  }
  
  if (!roomId || typeof roomId !== 'string') {
    errors.push('Invalid room ID');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  createPresignedPost: createPresignedPostUrl,
  getSignedGetUrl,
  validateMimeType,
  validateFileSize,
  validateUploadRequest,
};


