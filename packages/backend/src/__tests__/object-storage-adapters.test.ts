// Config validation for the object-store adapters. These checks run before any
// SDK import or network call, so they test without live cloud credentials. The
// list/download behaviour is exercised by the orchestrator suite (against a fake
// store) and, for real, only against a live bucket.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createS3Store } from '../lib/object-storage/s3';
import { createAzureBlobStore } from '../lib/object-storage/azure-blob';
import { createGcsStore } from '../lib/object-storage/gcs';

describe('object-store adapter construction', () => {
  it('S3 requires a bucket, otherwise returns a store', () => {
    assert.throws(() => createS3Store({ bucket: '' }), /bucket/i);
    const s = createS3Store({ bucket: 'b', region: 'us-east-1' });
    assert.strictEqual(typeof s.list, 'function');
    assert.strictEqual(typeof s.download, 'function');
  });

  it('Azure Blob requires account, container, and a key or SAS token', () => {
    assert.throws(() => createAzureBlobStore({ account: '', container: 'c', accountKey: 'k' }), /storage account/i);
    assert.throws(() => createAzureBlobStore({ account: 'a', container: '', accountKey: 'k' }), /container/i);
    assert.throws(() => createAzureBlobStore({ account: 'a', container: 'c' }), /account key or a SAS token/i);
    assert.ok(createAzureBlobStore({ account: 'a', container: 'c', accountKey: 'k' }));
    assert.ok(createAzureBlobStore({ account: 'a', container: 'c', sasToken: 'sv=...' }));
  });

  it('GCS requires a bucket; credentials are optional (ADC)', () => {
    assert.throws(() => createGcsStore({ bucket: '' }), /bucket/i);
    assert.ok(createGcsStore({ bucket: 'b' }));                       // ADC
    assert.ok(createGcsStore({ bucket: 'b', serviceAccountJson: '{}' })); // explicit key
  });
});
