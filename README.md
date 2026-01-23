# Cloudfront Deploy Action

This action syncs your static files to S3 and invalidates the CloudFront cache.

## What's New in v1.0.0

**Major breaking change:** This version now syncs files like `aws s3 sync --delete` by default:
- ✅ Uploads new and changed files
- ✅ Skips unchanged files (based on MD5/ETag comparison)
- ✅ **Deletes files in S3 that don't exist locally** (new behavior)
- ✅ Proper async/await flow (fixes race conditions)
- ✅ Better error handling
- ✅ Uses AWS SDK v3
- ✅ Node 20 runtime

This eliminates caching issues caused by old files remaining in S3.

## Inputs

### `s3-bucket-name`

**Required** The name of the target S3 bucket.

### `build-folder-path`

**Required** The artifacts folder path containing files to deploy.

### `delete-non-existing`

**Optional** Delete files in S3 that do not exist locally (sync --delete behavior). Default: `true`

Set to `false` to preserve v0.x behavior (upload only, no deletion).

### `dry-run`

**Optional** Preview changes without applying them. Default: `false`

Useful for testing before actual deployment.

### `s3-prefix`

**Optional** Prefix/folder path in S3 bucket. Default: `''` (root level)

### `bypass-deletion-check`

**Optional** Bypass the 90% deletion ratio safeguard for adhoc situations. Default: `false`

**Warning:** Use with caution. Only enable when you're certain a large deletion is intentional.

## Outputs

### `uploaded`

Number of files uploaded to S3.

### `skipped`

Number of files skipped (unchanged based on MD5 comparison).

### `deleted`

Number of files deleted from S3.

## Example Usage

### Basic usage (v1.0.0)

```yaml
- name: Deploy to CloudFront
  uses: SevenSenders/cloudfront-action@v1
  with:
    s3-bucket-name: my-bucket
    build-folder-path: ./dist
```

### Preview changes with dry-run

```yaml
- name: Preview deployment
  uses: SevenSenders/cloudfront-action@v1
  with:
    s3-bucket-name: my-bucket
    build-folder-path: ./dist
    dry-run: true
```

### Preserve v0.x behavior (no deletion)

```yaml
- name: Deploy without deletion
  uses: SevenSenders/cloudfront-action@v1
  with:
    s3-bucket-name: my-bucket
    build-folder-path: ./dist
    delete-non-existing: false
```

### Deploy to S3 subfolder

```yaml
- name: Deploy to subfolder
  uses: SevenSenders/cloudfront-action@v1
  with:
    s3-bucket-name: my-bucket
    build-folder-path: ./dist
    s3-prefix: v2/app
```

### Bypass deletion safeguard (adhoc use)

```yaml
- name: Deploy with large deletion
  uses: SevenSenders/cloudfront-action@v1
  with:
    s3-bucket-name: my-bucket
    build-folder-path: ./dist
    bypass-deletion-check: true  # Use with caution
```

## Migrating from v0.x to v1.0.0

### Breaking Changes

1. **Files are now deleted by default**
   - v0.x: Only uploaded files, never deleted
   - v1.0.0: Syncs files (uploads + deletes orphaned files)
   - Migration: Set `delete-non-existing: false` to keep old behavior

2. **Node 20 required**
   - v0.x: node16
   - v1.0.0: node20
   - Migration: None required (GitHub Actions handles this)

3. **Errors now fail the action**
   - v0.x: Upload errors were logged but didn't fail the action
   - v1.0.0: Any error fails the action
   - Migration: Fix underlying issues (e.g., missing IAM permissions)

### Required IAM Permissions

Your IAM role/user now needs the `s3:DeleteObject` permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::your-bucket",
        "arn:aws:s3:::your-bucket/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudfront:ListDistributions",
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation"
      ],
      "Resource": "*"
    }
  ]
}
```

### Migration Steps

1. **Test with dry-run first:**
   ```yaml
   - uses: SevenSenders/cloudfront-action@v1
     with:
       s3-bucket-name: my-bucket
       build-folder-path: ./dist
       dry-run: true
   ```

2. **Review what will be deleted:**
   Check the dry-run output to see which files would be removed.

3. **Add IAM permission:**
   Ensure your deployment role has `s3:DeleteObject` permission.

4. **Deploy to staging first:**
   Test on a non-production environment before updating production workflows.

## How It Works

1. **List S3 objects** - Retrieves all files currently in the S3 bucket
2. **Scan local files** - Walks the build directory and calculates MD5 hashes
3. **Upload files** - Uploads new/changed files (skips unchanged based on ETag comparison)
4. **Delete orphaned files** - Removes S3 files that don't exist locally (if `delete-non-existing: true`)
5. **Invalidate CloudFront** - Creates cache invalidation (only if changes detected)

## Performance

- **Skips unchanged files** - Saves ~80-90% of S3 PUT requests for typical deployments
- **Batch deletions** - Deletes up to 1000 files per API call
- **Controlled concurrency** - Uploads 10 files in parallel
- **Smart invalidation** - Only invalidates if files changed

## Safety Features

- **Empty folder check** - Refuses to sync if local folder is empty (would delete everything)
- **Max deletion ratio** - Refuses to delete >90% of files in one run (can be bypassed for adhoc situations)
- **Dry-run mode** - Preview changes before applying
- **Detailed logging** - Clear output of what changed

### Bypassing the Deletion Safeguard

For adhoc situations where you need to delete a large portion of files, you can bypass the deletion ratio check:

**In GitHub Actions workflow:**

```yaml
- name: Deploy with bypass
  uses: SevenSenders/cloudfront-action@v1
  with:
    s3-bucket-name: my-bucket
    build-folder-path: ./dist
    bypass-deletion-check: true
```

**Warning:** Only use this option when you're certain the deletion is intentional.

## License

Apache-2.0