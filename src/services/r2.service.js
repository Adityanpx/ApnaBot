const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const config = require('../config/env');

const r2 = new S3Client({
  region: 'auto',
  endpoint: config.R2_ENDPOINT,
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Upload a file buffer to R2
 * @param {Buffer} fileBuffer - file buffer (e.g. from multer memoryStorage)
 * @param {string} folder - e.g. 'shop-profiles'
 * @param {string} publicId - filename without extension
 * @param {string} mimetype - e.g. 'image/png'
 * @returns {Promise<{ url: string, key: string }>}
 */
const uploadImage = async (fileBuffer, folder, publicId, mimetype) => {
  const ext = mimetype.split('/')[1];
  const key = `${folder}/${publicId}.${ext}`;

  await r2.send(new PutObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: mimetype,
  }));

  return {
    url: `${config.R2_PUBLIC_URL}/${key}`,
    key,
  };
};

/**
 * Delete a file from R2 by its key
 * @param {string} key
 */
const deleteImage = async (key) => {
  return r2.send(new DeleteObjectCommand({
    Bucket: config.R2_BUCKET_NAME,
    Key: key,
  }));
};

module.exports = { uploadImage, deleteImage };
