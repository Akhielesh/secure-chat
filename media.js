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

async function createPresignedPostUrl({ key, contentType, maxBytes }) {
  const conditions = [
    ['content-length-range', 0, maxBytes],
    { 'Content-Type': contentType },
  ];
  const fields = { 'Content-Type': contentType, key };
  const { url, fields: postFields } = await createPresignedPost(s3, {
    Bucket: R2_BUCKET,
    Key: key,
    Conditions: conditions,
    Fields: fields,
    Expires: 60, // seconds
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


