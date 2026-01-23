const { 
  S3Client, 
  ListObjectsV2Command, 
  DeleteObjectsCommand, 
  PutObjectCommand 
} = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');

const s3Client = new S3Client({});

/**
 * List ALL objects in S3 bucket (handles pagination)
 */
async function listAllS3Objects(bucket, prefix = '') {
  const objects = new Map(); // key -> { ETag, Size }
  let continuationToken;
  
  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000
    });
    
    const response = await s3Client.send(command);
    
    for (const obj of (response.Contents || [])) {
      objects.set(obj.Key, {
        ETag: obj.ETag?.replace(/"/g, ''), // Remove quotes from ETag
        Size: obj.Size
      });
    }
    
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  
  return objects;
}

/**
 * Walk local directory and build file map
 */
function getLocalFiles(buildFolderPath) {
  const files = new Map(); // key -> { localPath, md5, content }
  
  function walkSync(currentDirPath) {
    for (const name of fs.readdirSync(currentDirPath)) {
      const filePath = path.join(currentDirPath, name);
      const stat = fs.statSync(filePath);
      
      if (stat.isFile()) {
        // Calculate S3 key (relative path from build folder)
        const s3Key = path.relative(buildFolderPath, filePath);
        
        // Calculate MD5 for change detection (matches S3 ETag for non-multipart)
        const content = fs.readFileSync(filePath);
        const md5 = crypto.createHash('md5').update(content).digest('hex');
        
        files.set(s3Key, { localPath: filePath, md5, content });
      } else if (stat.isDirectory()) {
        walkSync(filePath);
      }
    }
  }
  
  walkSync(buildFolderPath);
  return files;
}

/**
 * Delete objects from S3 in batches
 */
async function deleteS3Objects(bucket, keys) {
  if (keys.length === 0) return;
  
  // DeleteObjectsCommand accepts max 1000 keys per request
  const batches = [];
  for (let i = 0; i < keys.length; i += 1000) {
    batches.push(keys.slice(i, i + 1000));
  }
  
  for (const batch of batches) {
    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: batch.map(key => ({ Key: key })),
        Quiet: false
      }
    });
    
    const response = await s3Client.send(command);
    
    // Check for errors
    if (response.Errors && response.Errors.length > 0) {
      for (const error of response.Errors) {
        console.error(`Failed to delete ${error.Key}: ${error.Message}`);
      }
      throw new Error(`Failed to delete ${response.Errors.length} objects`);
    }
    
    console.log(`Deleted ${batch.length} objects`);
  }
}

/**
 * Upload files to S3 with concurrency control
 */
async function uploadFiles(bucket, files, s3Objects, skipUnchanged = true) {
  const uploads = [];
  const skipped = [];
  
  for (const [s3Key, fileInfo] of files) {
    const existing = s3Objects.get(s3Key);
    
    // Skip if file unchanged (ETag matches MD5)
    if (skipUnchanged && existing && existing.ETag === fileInfo.md5) {
      skipped.push(s3Key);
      continue;
    }
    
    uploads.push({ s3Key, fileInfo });
  }
  
  console.log(`Uploading ${uploads.length} files, skipping ${skipped.length} unchanged`);
  
  // Upload with concurrency limit
  const CONCURRENCY = 10;
  for (let i = 0; i < uploads.length; i += CONCURRENCY) {
    const batch = uploads.slice(i, i + CONCURRENCY);
    
    await Promise.all(batch.map(async ({ s3Key, fileInfo }) => {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: fileInfo.content,
        ContentType: mime.lookup(s3Key) || 'application/octet-stream'
      });
      
      await s3Client.send(command);
      console.log(`Uploaded: ${s3Key}`);
    }));
  }
  
  return { uploaded: uploads.length, skipped: skipped.length };
}

/**
 * Main sync function
 */
async function syncToS3(bucket, buildFolderPath, options = {}) {
  const { 
    deleteNonExisting = true,
    dryRun = false,
    prefix = '',
    maxDeletionRatio = 0.9
  } = options;
  
  console.log(`Syncing ${buildFolderPath} to s3://${bucket}/${prefix}`);
  console.log(`Options: deleteNonExisting=${deleteNonExisting}, dryRun=${dryRun}`);
  
  // Step 1: List S3 objects
  console.log('Listing S3 objects...');
  const s3Objects = await listAllS3Objects(bucket, prefix);
  console.log(`Found ${s3Objects.size} objects in S3`);
  
  // Step 2: Get local files
  console.log('Scanning local files...');
  const localFiles = getLocalFiles(buildFolderPath);
  console.log(`Found ${localFiles.size} local files`);
  
  // SAFEGUARD 1: Don't sync empty folder
  if (localFiles.size === 0) {
    throw new Error('Local folder is empty - refusing to sync (would delete all S3 objects)');
  }
  
  // Step 3: Determine files to delete (in S3 but not local)
  const toDelete = [];
  for (const s3Key of s3Objects.keys()) {
    if (!localFiles.has(s3Key)) {
      toDelete.push(s3Key);
    }
  }
  
  console.log(`Files to delete: ${toDelete.length}`);
  if (toDelete.length > 0 && toDelete.length <= 20) {
    console.log('Will delete:', toDelete);
  }
  
  // SAFEGUARD 2: Limit max deletions (don't delete > 90% of files)
  if (s3Objects.size > 10 && toDelete.length > 0) {
    const deleteRatio = toDelete.length / s3Objects.size;
    if (deleteRatio > maxDeletionRatio) {
      throw new Error(
        `Refusing to delete ${toDelete.length}/${s3Objects.size} files (>${maxDeletionRatio * 100}%). ` +
        `This appears to be a destructive operation. Check your build folder.`
      );
    }
  }
  
  if (dryRun) {
    console.log('DRY RUN - no changes made');
    return { 
      uploaded: 0, 
      skipped: localFiles.size, 
      deleted: 0, 
      wouldDelete: toDelete.length 
    };
  }
  
  // Step 4: Upload new/changed files
  const uploadResult = await uploadFiles(bucket, localFiles, s3Objects);
  
  // Step 5: Delete orphaned files (if enabled)
  let deleted = 0;
  if (deleteNonExisting && toDelete.length > 0) {
    await deleteS3Objects(bucket, toDelete);
    deleted = toDelete.length;
  } else if (toDelete.length > 0) {
    console.log(`Skipping deletion of ${toDelete.length} files (deleteNonExisting=false)`);
  }
  
  return {
    uploaded: uploadResult.uploaded,
    skipped: uploadResult.skipped,
    deleted
  };
}

module.exports = { syncToS3, listAllS3Objects, deleteS3Objects };
