const core = require('@actions/core');
const { 
  CloudFrontClient, 
  ListDistributionsCommand,
  CreateInvalidationCommand,
  waitUntilInvalidationCompleted
} = require('@aws-sdk/client-cloudfront');
const { syncToS3 } = require('./sync');

const cloudFrontClient = new CloudFrontClient({});

async function getDistributionId(bucketName) {
  let marker;
  
  do {
    const command = new ListDistributionsCommand({ Marker: marker });
    const response = await cloudFrontClient.send(command);
    
    for (const distribution of (response.DistributionList?.Items || [])) {
      if (distribution.Aliases?.Items?.includes(bucketName)) {
        console.log(`Found CloudFront distribution: ${distribution.Id}`);
        return distribution.Id;
      }
    }
    
    marker = response.DistributionList?.NextMarker;
  } while (marker);
  
  throw new Error(`No CloudFront distribution found for alias: ${bucketName}`);
}

async function createInvalidation(distributionId, paths) {
  const command = new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: `${Date.now()}`,
      Paths: {
        Quantity: paths.length,
        Items: paths
      }
    }
  });
  
  const response = await cloudFrontClient.send(command);
  const invalidationId = response.Invalidation.Id;
  
  console.log(`Created invalidation: ${invalidationId}`);
  
  // Wait for completion
  await waitUntilInvalidationCompleted(
    { client: cloudFrontClient, maxWaitTime: 600 }, // 10 min timeout
    { DistributionId: distributionId, Id: invalidationId }
  );
  
  console.log('Invalidation completed');
}

async function run() {
  try {
    // Read inputs
    const bucket = core.getInput('s3-bucket-name', { required: true });
    const buildFolderPath = core.getInput('build-folder-path', { required: true });
    const deleteNonExisting = core.getBooleanInput('delete-non-existing');
    const dryRun = core.getBooleanInput('dry-run');
    const prefix = core.getInput('s3-prefix');
    const bypassDeletionCheck = core.getBooleanInput('bypass-deletion-check');
    
    console.log(`Starting deployment to S3 bucket: ${bucket}`);
    
    // Step 1: Sync files to S3
    const result = await syncToS3(bucket, buildFolderPath, {
      deleteNonExisting,
      dryRun,
      prefix,
      bypassDeletionCheck
    });
    
    console.log(`Sync complete: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.deleted} deleted`);
    
    // Set outputs
    core.setOutput('uploaded', result.uploaded);
    core.setOutput('skipped', result.skipped);
    core.setOutput('deleted', result.deleted);
    
    if (dryRun) {
      console.log('Dry run - skipping CloudFront invalidation');
      return;
    }
    
    // Step 2: Invalidate CloudFront (only if files changed)
    if (result.uploaded > 0 || result.deleted > 0) {
      console.log('Changes detected - invalidating CloudFront cache');
      const distributionId = await getDistributionId(bucket);
      await createInvalidation(distributionId, ['/*']);
    } else {
      console.log('No changes - skipping CloudFront invalidation');
    }
    
    console.log('Deployment completed successfully');
    
  } catch (error) {
    console.error('Deployment failed:', error.message);
    core.setFailed(error.message);
    process.exit(1);
  }
}

run();
