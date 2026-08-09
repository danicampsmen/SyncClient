import { describe, expect, test } from 'vitest';
import { Md5 } from './md5';

describe('Md5', () => {
  test('hashes data split across arbitrary stream chunks', () => {
    const input = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    const hash = new Md5();
    for (let i = 0; i < input.length; i += 3) hash.update(input.subarray(i, i + 3));
    expect(hash.digest()).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  test('hashes empty input', () => {
    expect(new Md5().digest()).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
});
