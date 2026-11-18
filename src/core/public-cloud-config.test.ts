import { describe, expect, it } from 'vitest';
import { readPublicCloudConfig } from './public-cloud-config';

describe('public cloud configuration', () => {
  const url = 'https://reader.example';
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role })).replace(/=+$/, '')}.fixture`;
  it('accepts only documented public key formats and local development HTTP', () => {
    expect(readPublicCloudConfig(url, 'sb_publishable_fixture')).toEqual({ url, anonKey: 'sb_publishable_fixture' });
    expect(readPublicCloudConfig('http://127.0.0.1:54321', jwt('anon'))).toEqual({ url: 'http://127.0.0.1:54321', anonKey: jwt('anon') });
  });
  it('fails closed on private keys, embedded credentials and origin confusion without echoing input', () => {
    for (const key of ['sb_secret_fixture', jwt('service_role'), jwt('authenticated'), 'fixture.with.invalid-payload']) {
      expect(() => readPublicCloudConfig(url, key)).toThrow('publishable / anon 公钥');
    }
    for (const invalid of ['https://username:password@reader.example', 'ftp://localhost', 'http://reader.example', 'https://reader.example/rest/v1', 'https://reader.example/?param=secret']) {
      expect(() => readPublicCloudConfig(invalid, 'sb_publishable_fixture')).toThrow();
    }
  });
});
