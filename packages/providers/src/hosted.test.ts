import { describe, expect, it } from 'vitest';
import { parseAzureRemote } from './azure/client.js';
import { parseBitbucketRemote, parseBitbucketSlug } from './bitbucket/client.js';

describe('parseBitbucketRemote', () => {
  it('reads bitbucket.org remotes over https and ssh', () => {
    const ref = { workspace: 'acme', repository: 'shop' };
    expect(parseBitbucketRemote('https://ada@bitbucket.org/acme/shop.git')).toEqual(ref);
    expect(parseBitbucketRemote('git@bitbucket.org:acme/shop.git')).toEqual(ref);
    expect(parseBitbucketSlug('acme/shop')).toEqual(ref);
  });

  it('ignores other hosts and malformed paths', () => {
    expect(parseBitbucketRemote('https://bitbucket.example.com/scm/acme/shop.git')).toBeNull();
    expect(parseBitbucketRemote('https://github.com/acme/shop.git')).toBeNull();
    expect(parseBitbucketSlug('acme/shop/extra')).toBeNull();
    expect(parseBitbucketSlug('acme/../x')).toBeNull();
  });
});

describe('parseAzureRemote', () => {
  it('reads dev.azure.com, ssh and visualstudio.com remotes, decoding names', () => {
    const ref = { organization: 'acme', project: 'Shop Project', repository: 'shop' };
    expect(parseAzureRemote('https://acme@dev.azure.com/acme/Shop%20Project/_git/shop')).toEqual(
      ref,
    );
    expect(parseAzureRemote('git@ssh.dev.azure.com:v3/acme/Shop%20Project/shop')).toEqual(ref);
    expect(
      parseAzureRemote('https://acme.visualstudio.com/DefaultCollection/Shop%20Project/_git/shop'),
    ).toEqual(ref);
  });

  it('ignores other hosts and paths that are not repositories', () => {
    expect(parseAzureRemote('https://dev.azure.com/acme/Shop/_wiki/shop')).toBeNull();
    expect(parseAzureRemote('https://evil.example/acme/Shop/_git/shop')).toBeNull();
    expect(parseAzureRemote('https://dev.azure.com/acme/Shop%2Fx/_git/shop')).toBeNull();
  });
});
