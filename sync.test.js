const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { S3Client } = require('@aws-sdk/client-s3');
const { syncToS3, getLocalFiles, normalizePrefix } = require('./sync');

const md5 = (content) => crypto.createHash('md5').update(content).digest('hex');

let buildDir;
let sent;
let originalSend;

/**
 * Stub every S3 call: ListObjectsV2 returns the given objects, writes are recorded
 */
function stubS3(existingObjects) {
  S3Client.prototype.send = async function (command) {
    sent.push(command);
    switch (command.constructor.name) {
      case 'ListObjectsV2Command':
        return {
          Contents: Object.entries(existingObjects)
            .filter(([key]) => key.startsWith(command.input.Prefix || ''))
            .map(([key, content]) => ({ Key: key, ETag: `"${md5(content)}"`, Size: content.length }))
        };
      case 'PutObjectCommand':
        return {};
      case 'DeleteObjectsCommand':
        return { Errors: [] };
      default:
        throw new Error(`Unexpected command: ${command.constructor.name}`);
    }
  };
}

const commands = (name) => sent.filter((command) => command.constructor.name === name);

beforeEach(() => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudfront-action-'));
  fs.mkdirSync(path.join(buildDir, 'assets'));
  fs.writeFileSync(path.join(buildDir, 'index.html'), 'index');
  fs.writeFileSync(path.join(buildDir, 'assets', 'app.js'), 'app-v2');
  sent = [];
  originalSend = S3Client.prototype.send;
});

afterEach(() => {
  S3Client.prototype.send = originalSend;
  fs.rmSync(buildDir, { recursive: true, force: true });
});

test('normalizePrefix strips slashes and keeps exactly one trailing slash', () => {
  assert.equal(normalizePrefix(''), '');
  assert.equal(normalizePrefix('/'), '');
  assert.equal(normalizePrefix('v2/app'), 'v2/app/');
  assert.equal(normalizePrefix('/v2/app/'), 'v2/app/');
  assert.equal(normalizePrefix('v2/app//'), 'v2/app/');
});

test('getLocalFiles builds "/"-separated keys under the prefix', () => {
  const keys = [...getLocalFiles(buildDir, 'v2/app/').keys()].sort();
  assert.deepEqual(keys, ['v2/app/assets/app.js', 'v2/app/index.html']);
});

test('sync with s3-prefix uploads, skips and deletes inside the prefix only', async () => {
  stubS3({
    'v2/app/index.html': 'index',      // unchanged -> skipped
    'v2/app/assets/app.js': 'app-v1',  // changed -> uploaded
    'v2/app/old.js': 'stale',          // orphan -> deleted
    'v2/app2/keep.js': 'sibling'       // sibling folder -> untouched
  });

  const result = await syncToS3('bucket', buildDir, { prefix: 'v2/app' });

  assert.equal(commands('ListObjectsV2Command')[0].input.Prefix, 'v2/app/');
  assert.deepEqual(commands('PutObjectCommand').map((c) => c.input.Key), ['v2/app/assets/app.js']);
  assert.deepEqual(
    commands('DeleteObjectsCommand').flatMap((c) => c.input.Delete.Objects.map((o) => o.Key)),
    ['v2/app/old.js']
  );
  assert.deepEqual(result, { uploaded: 1, skipped: 1, deleted: 1 });
});

test('sync without prefix keeps keys at the bucket root', async () => {
  stubS3({ 'index.html': 'index', 'old.js': 'stale' });

  const result = await syncToS3('bucket', buildDir);

  assert.equal(commands('ListObjectsV2Command')[0].input.Prefix, '');
  assert.deepEqual(commands('PutObjectCommand').map((c) => c.input.Key), ['assets/app.js']);
  assert.deepEqual(
    commands('DeleteObjectsCommand').flatMap((c) => c.input.Delete.Objects.map((o) => o.Key)),
    ['old.js']
  );
  assert.deepEqual(result, { uploaded: 1, skipped: 1, deleted: 1 });
});

test('dry run with prefix performs no writes', async () => {
  stubS3({ 'v2/app/old.js': 'stale' });

  const result = await syncToS3('bucket', buildDir, { prefix: 'v2/app', dryRun: true });

  assert.equal(commands('PutObjectCommand').length, 0);
  assert.equal(commands('DeleteObjectsCommand').length, 0);
  assert.equal(result.wouldDelete, 1);
});
