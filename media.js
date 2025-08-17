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
    ['content-length-range', 1, maxBytes], // Must be at least 1 byte
    ['starts-with', '$Content-Type', contentType], // Exact content-type match
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
    Expires: 60, // seconds - short expiry for security
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

module.exports = {
  createPresignedPost: createPresignedPostUrl,
  getSignedGetUrl,
};


