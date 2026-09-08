// SSRF guard for the direct-connect driver layer (B4 #5).
//
// The classifier is pure and covers the range logic; assertConnectableHost is
// exercised with IP literals (no DNS) for the always-block metadata case and
// the opt-in private/loopback hardening.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { classifyIp, normalizeHost, assertConnectableHost } from '../lib/db-source/ssrf-guard';

describe('classifyIp', () => {
  it('flags the cloud metadata / link-local range', () => {
    assert.equal(classifyIp('169.254.169.254'), 'metadata-link-local');
    assert.equal(classifyIp('169.254.0.1'), 'metadata-link-local');
    assert.equal(classifyIp('fe80::1'), 'metadata-link-local');
    assert.equal(classifyIp('fd00:ec2::254'), 'metadata-link-local');
  });
  it('flags loopback', () => {
    assert.equal(classifyIp('127.0.0.1'), 'loopback');
    assert.equal(classifyIp('::1'), 'loopback');
  });
  it('flags RFC-1918 / unique-local private ranges', () => {
    assert.equal(classifyIp('10.1.2.3'), 'private');
    assert.equal(classifyIp('172.16.0.9'), 'private');
    assert.equal(classifyIp('172.31.255.255'), 'private');
    assert.equal(classifyIp('192.168.1.1'), 'private');
    assert.equal(classifyIp('fd12::1'), 'private');
  });
  it('treats 172.15/172.32 as public (outside the /12)', () => {
    assert.equal(classifyIp('172.15.0.1'), 'public');
    assert.equal(classifyIp('172.32.0.1'), 'public');
  });
  it('classifies real public addresses as public', () => {
    assert.equal(classifyIp('8.8.8.8'), 'public');
    assert.equal(classifyIp('2606:4700:4700::1111'), 'public');
  });
  it('maps an IPv4-mapped IPv6 address to its embedded v4 class', () => {
    assert.equal(classifyIp('::ffff:169.254.169.254'), 'metadata-link-local');
    assert.equal(classifyIp('::ffff:10.0.0.1'), 'private');
  });
});

describe('normalizeHost', () => {
  it('strips a trailing port from a hostname or IPv4', () => {
    assert.equal(normalizeHost('db.example.com:5432'), 'db.example.com');
    assert.equal(normalizeHost('10.0.0.5:3306'), '10.0.0.5');
  });
  it('unwraps a bracketed IPv6 literal', () => {
    assert.equal(normalizeHost('[::1]:5432'), '::1');
  });
  it('leaves a bare IPv6 literal intact', () => {
    assert.equal(normalizeHost('fd00::1'), 'fd00::1');
  });
});

describe('assertConnectableHost', () => {
  const saved = process.env.DB_SOURCE_BLOCK_PRIVATE_HOSTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DB_SOURCE_BLOCK_PRIVATE_HOSTS;
    else process.env.DB_SOURCE_BLOCK_PRIVATE_HOSTS = saved;
  });

  it('always refuses the metadata endpoint', async () => {
    await assert.rejects(() => assertConnectableHost('169.254.169.254'), /link-local\/metadata/);
    await assert.rejects(() => assertConnectableHost('[fd00:ec2::254]'), /link-local\/metadata/);
  });

  it('allows loopback and private DBs by default (dev / on-prem)', async () => {
    delete process.env.DB_SOURCE_BLOCK_PRIVATE_HOSTS;
    await assert.doesNotReject(() => assertConnectableHost('127.0.0.1'));
    await assert.doesNotReject(() => assertConnectableHost('10.20.30.40:5432'));
  });

  it('refuses loopback and private when DB_SOURCE_BLOCK_PRIVATE_HOSTS is set', async () => {
    process.env.DB_SOURCE_BLOCK_PRIVATE_HOSTS = '1';
    await assert.rejects(() => assertConnectableHost('127.0.0.1'), /loopback/);
    await assert.rejects(() => assertConnectableHost('192.168.1.10'), /private/);
  });
});
