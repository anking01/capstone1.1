const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Try to load AWS SDK, but don't fail if not available
let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadBucketCommand, CreateBucketCommand;
try {
  const s3 = require('@aws-sdk/client-s3');
  S3Client = s3.S3Client;
  PutObjectCommand = s3.PutObjectCommand;
  GetObjectCommand = s3.GetObjectCommand;
  DeleteObjectCommand = s3.DeleteObjectCommand;
  ListObjectsV2Command = s3.ListObjectsV2Command;
  HeadBucketCommand = s3.HeadBucketCommand;
  CreateBucketCommand = s3.CreateBucketCommand;
} catch (error) {
  console.log('⚠️ AWS SDK not available - using local storage fallback');
  S3Client = null;
}

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.json': 'application/json',
};

class AwsStorageService {
  constructor() {
    this.bucketName = process.env.AWS_S3_BUCKET || 'face-images';
    this.region = process.env.AWS_REGION || 'ap-south-1';
    // Local fallback root (volume-mounted in Docker so it survives rebuilds)
    this.localDir = process.env.LOCAL_STORAGE_DIR || path.join(__dirname, '../../uploads/storage');

    const hasCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

    // Only initialize S3 if SDK is available AND credentials are set
    if (S3Client && hasCreds) {
      this.s3Client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });
      console.log(`☁️ AWS S3 storage enabled (bucket: ${this.bucketName}, region: ${this.region})`);
    } else {
      if (!hasCreds) {
        console.log('🔄 AWS credentials not set - using local storage fallback');
      } else {
        console.log('🔄 AWS Storage not available - using local storage fallback');
      }
      this.s3Client = null;
    }
  }

  isUsingS3() {
    return this.s3Client !== null;
  }

  // ---------- local fallback helpers ----------

  localPath(key) {
    return path.join(this.localDir, key);
  }

  async ensureLocalDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  contentTypeFor(fileName) {
    return CONTENT_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
  }

  async initializeContainer() {
    if (!this.s3Client) {
      await this.ensureLocalDir(path.join(this.localDir, 'faces'));
      await this.ensureLocalDir(path.join(this.localDir, 'encodings'));
      console.log(`📁 Local storage ready at ${this.localDir}`);
      return;
    }

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      console.log('✅ AWS S3 bucket found');
    } catch (error) {
      // Bucket doesn't exist (or no access) - try to create it
      try {
        await this.s3Client.send(new CreateBucketCommand({
          Bucket: this.bucketName,
          ...(this.region !== 'us-east-1' && {
            CreateBucketConfiguration: { LocationConstraint: this.region }
          })
        }));
        console.log('✅ AWS S3 bucket created');
      } catch (createError) {
        console.log('⚠️ AWS S3 initialization failed:', createError.message);
        console.log('🔄 Continuing without AWS Storage - local storage will be used');
        this.s3Client = null;
        await this.ensureLocalDir(path.join(this.localDir, 'faces'));
        await this.ensureLocalDir(path.join(this.localDir, 'encodings'));
      }
    }
  }

  async uploadFaceImage(studentId, imageBuffer, originalName) {
    try {
      const fileExtension = (originalName.split('.').pop() || 'jpg').toLowerCase();
      const baseName = `${crypto.randomUUID()}.${fileExtension}`;
      const fileName = `faces/${studentId}/${baseName}`;

      const metadata = {
        studentid: studentId.toString(),
        originalname: originalName,
        uploadedat: new Date().toISOString(),
      };

      if (!this.s3Client) {
        const filePath = this.localPath(fileName);
        await this.ensureLocalDir(path.dirname(filePath));
        await fs.promises.writeFile(filePath, imageBuffer);
        console.log(`✅ Face image saved locally for student ${studentId}: ${fileName}`);
        return {
          url: `/api/storage/face/${studentId}/${baseName}`,
          fileName,
          metadata,
        };
      }

      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileName,
        Body: imageBuffer,
        ContentType: this.contentTypeFor(baseName),
        Metadata: metadata,
      }));

      const url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${fileName}`;
      console.log(`✅ Face image uploaded for student ${studentId}: ${fileName}`);

      return { url, fileName, metadata };
    } catch (error) {
      console.error(`❌ Error uploading face image for student ${studentId}:`, error);
      throw error;
    }
  }

  async getFaceImage(studentId, fileName) {
    try {
      const key = `faces/${studentId}/${fileName}`;

      if (!this.s3Client) {
        const buffer = await fs.promises.readFile(this.localPath(key));
        return {
          buffer,
          metadata: {},
          contentType: this.contentTypeFor(fileName),
        };
      }

      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));

      return {
        buffer: await streamToBuffer(response.Body),
        metadata: response.Metadata,
        contentType: response.ContentType,
      };
    } catch (error) {
      console.error(`❌ Error retrieving face image for student ${studentId}:`, error);
      throw error;
    }
  }

  async listFaceImages(studentId) {
    try {
      if (!this.s3Client) {
        const dir = this.localPath(`faces/${studentId}`);
        let entries = [];
        try {
          entries = await fs.promises.readdir(dir);
        } catch (e) {
          if (e.code === 'ENOENT') return [];
          throw e;
        }
        const images = [];
        for (const entry of entries) {
          const stat = await fs.promises.stat(path.join(dir, entry));
          if (!stat.isFile()) continue;
          images.push({
            name: `faces/${studentId}/${entry}`,
            url: `/api/storage/face/${studentId}/${entry}`,
            uploadedAt: stat.mtime,
            size: stat.size,
          });
        }
        return images;
      }

      const images = [];
      const response = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `faces/${studentId}/`,
      }));

      for (const obj of response.Contents || []) {
        images.push({
          name: obj.Key,
          url: `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${obj.Key}`,
          uploadedAt: obj.LastModified,
          size: obj.Size,
        });
      }

      return images;
    } catch (error) {
      console.error(`❌ Error listing face images for student ${studentId}:`, error);
      throw error;
    }
  }

  async deleteFaceImage(studentId, fileName) {
    try {
      const key = `faces/${studentId}/${fileName}`;

      if (!this.s3Client) {
        await fs.promises.rm(this.localPath(key), { force: true });
        console.log(`✅ Face image deleted locally for student ${studentId}: ${fileName}`);
        return true;
      }

      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));

      console.log(`✅ Face image deleted for student ${studentId}: ${fileName}`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting face image for student ${studentId}:`, error);
      throw error;
    }
  }

  async deleteAllFaceImages(studentId) {
    try {
      if (!this.s3Client) {
        await fs.promises.rm(this.localPath(`faces/${studentId}`), { recursive: true, force: true });
        console.log(`✅ All face images deleted locally for student ${studentId}`);
        return true;
      }

      const images = await this.listFaceImages(studentId);
      const deletePromises = images.map(image =>
        this.deleteFaceImage(studentId, image.name.split('/').pop())
      );

      await Promise.all(deletePromises);
      console.log(`✅ All face images deleted for student ${studentId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting all face images for student ${studentId}:`, error);
      throw error;
    }
  }

  async uploadFaceEncoding(studentId, encodingData) {
    try {
      const fileName = `encodings/${studentId}.json`;
      const encodingJson = JSON.stringify(encodingData);

      const metadata = {
        studentid: studentId.toString(),
        uploadedat: new Date().toISOString(),
        type: 'face-encoding',
      };

      if (!this.s3Client) {
        const filePath = this.localPath(fileName);
        await this.ensureLocalDir(path.dirname(filePath));
        await fs.promises.writeFile(filePath, encodingJson);
        console.log(`✅ Face encoding saved locally for student ${studentId}`);
        return {
          url: `/api/storage/encoding/${studentId}`,
          fileName,
          metadata,
        };
      }

      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileName,
        Body: encodingJson,
        ContentType: 'application/json',
        Metadata: metadata,
      }));

      console.log(`✅ Face encoding uploaded for student ${studentId}`);

      return {
        url: `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${fileName}`,
        fileName,
        metadata,
      };
    } catch (error) {
      console.error(`❌ Error uploading face encoding for student ${studentId}:`, error);
      throw error;
    }
  }

  async getFaceEncoding(studentId) {
    try {
      const fileName = `encodings/${studentId}.json`;

      if (!this.s3Client) {
        try {
          const buffer = await fs.promises.readFile(this.localPath(fileName));
          return JSON.parse(buffer.toString());
        } catch (e) {
          if (e.code === 'ENOENT') return null;
          throw e;
        }
      }

      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: fileName,
      }));

      const buffer = await streamToBuffer(response.Body);
      return JSON.parse(buffer.toString());
    } catch (error) {
      console.error(`❌ Error retrieving face encoding for student ${studentId}:`, error);
      return null;
    }
  }

  async deleteFaceEncoding(studentId) {
    try {
      const fileName = `encodings/${studentId}.json`;

      if (!this.s3Client) {
        await fs.promises.rm(this.localPath(fileName), { force: true });
        console.log(`✅ Face encoding deleted locally for student ${studentId}`);
        return true;
      }

      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: fileName,
      }));

      console.log(`✅ Face encoding deleted for student ${studentId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error deleting face encoding for student ${studentId}:`, error);
      throw error;
    }
  }

  async getStorageStats() {
    try {
      const stats = {
        storageMode: this.s3Client ? 's3' : 'local',
        totalImages: 0,
        totalEncodings: 0,
        totalSize: 0,
        studentCounts: {},
      };

      if (!this.s3Client) {
        const facesDir = this.localPath('faces');
        let studentDirs = [];
        try {
          studentDirs = await fs.promises.readdir(facesDir);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        for (const studentId of studentDirs) {
          const dir = path.join(facesDir, studentId);
          const stat = await fs.promises.stat(dir);
          if (!stat.isDirectory()) continue;
          const files = await fs.promises.readdir(dir);
          for (const f of files) {
            const fstat = await fs.promises.stat(path.join(dir, f));
            if (!fstat.isFile()) continue;
            stats.totalImages++;
            stats.totalSize += fstat.size;
            stats.studentCounts[studentId] = (stats.studentCounts[studentId] || 0) + 1;
          }
        }

        const encodingsDir = this.localPath('encodings');
        let encodingFiles = [];
        try {
          encodingFiles = await fs.promises.readdir(encodingsDir);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        for (const f of encodingFiles) {
          const fstat = await fs.promises.stat(path.join(encodingsDir, f));
          if (!fstat.isFile()) continue;
          stats.totalEncodings++;
          stats.totalSize += fstat.size;
        }

        return stats;
      }

      const response = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.bucketName,
      }));

      for (const obj of response.Contents || []) {
        stats.totalSize += obj.Size;

        if (obj.Key.startsWith('faces/')) {
          stats.totalImages++;
          const parts = obj.Key.split('/');
          const studentId = parts[1];
          stats.studentCounts[studentId] = (stats.studentCounts[studentId] || 0) + 1;
        } else if (obj.Key.startsWith('encodings/')) {
          stats.totalEncodings++;
        }
      }

      return stats;
    } catch (error) {
      console.error('❌ Error getting storage stats:', error);
      throw error;
    }
  }
}

// Helper function to convert a readable stream to a buffer
async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on('error', reject);
  });
}

module.exports = new AwsStorageService();
